import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
const { identity, freshConfig, requireUnused, verifyHistory, migrationSources, verifySourceState, verifyContainer,
  prepare, verify, verifyConfiguration, cleanup, freshPortMap, parsePortPolicy, publishedPorts,
  startupLockPath, verifyStartupLock, portCandidates, probePorts, PORT_BLOCK_LIMIT } = await import(process.env.CLUED_G4_TEST_MODULE_PATH ?
    pathToFileURL(process.env.CLUED_G4_TEST_MODULE_PATH).href : new URL('./clued-g4-fresh-start.mjs', import.meta.url));
const fixtureFile = relative => process.env.CLUED_G4_TEST_REPO_ROOT ? path.join(process.env.CLUED_G4_TEST_REPO_ROOT, relative) : new URL('../../' + relative, import.meta.url);

const env = { GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'owner/repo' };
const config = 'project_id = "clued-cloud"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[studio]\nport = 54323\n[local_smtp]\nport = 54324\n[analytics]\nport = 54327\n[db.pooler]\nport = 54329\n[edge_runtime]\ninspector_port = 8083\n[db.seed]\nenabled = false\n[other]\nvalue = true\n';

test('every attempt has a unique project and a different isolated port block', () => {
  assert.equal(identity(env).project, 'clued-g4-100-1');
  const second = { ...env, GITHUB_RUN_ATTEMPT: '2' };
  assert.equal(identity(second).project, 'clued-g4-100-2');
  assert.match(freshConfig(config, env), /project_id = "clued-g4-100-1"/);
  assert.match(freshConfig(config, env), /port = 17601/);
  assert.match(freshConfig(config, second), /port = 17617/);
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
  assert.equal((actual.match(/^[ \t]*(?:port|shadow_port|inspector_port)[ \t]*=[ \t]*176[01][0-9]$/gm) ?? []).length, 8);
  assert.match(actual, /inspector_port = 17610/);
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
  const runtime = { platform: 'linux', portProbe: async () => true, startLock: () => {},
    portPolicy: () => ({ ephemeral: [32768, 60999], reserved: [] }), git: (verb, ref) => {
    if (verb === 'show') return config;
    if (verb === 'status') return fs.readFileSync(path.join(app, 'config.toml'), 'utf8') === config ? '' : ' M apps/clued-cloud/supabase/config.toml';
    return ref === 'HEAD' ? e.GITHUB_SHA : root;
  }, docker: (...args) => {
    calls.push(args);
    if (args[0] === 'context') return JSON.stringify('unix:///var/run/docker.sock');
    if (args[0] === 'info') return JSON.stringify('fixture-daemon-identity');
    if (args[0] === 'ps' && args.includes('-q') && args.includes('--filter')) return 'c'.repeat(64);
    if (args[0] === 'inspect' && args.includes('{{json .NetworkSettings.Ports}}'))
      return JSON.stringify({ '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: String(JSON.parse(fs.readFileSync(
        path.join(root, `clued-g4-fresh-${run}-${attempt}.json`), 'utf8')).ports['db.port']) }] });
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
    // start only brings the containers up; the chain is applied in production's shape before the history is verified.
    const migrate = route.indexOf('node ../../scripts/ci/clued-local-migrate.mjs');
    assert.ok(migrate > route.indexOf('supabase start') && migrate < route.indexOf('--verify'));
    assert.equal(route.includes('supabase db reset'), false);
    for (const command of ['supabase db lint --local', 'supabase test db supabase/tests/m1_runtime_contracts.test.sql',
      'npm run test:project:lifecycle:v2']) assert.ok(route.includes(command));
    assert.ok(route.indexOf('--verify') < route.indexOf('supabase db lint'));
    assert.match(route, /if: always\(\) && env\.CLUED_G4_FRESH_PROJECT != ''/);
    assert.match(route, /exec 9>>"\$lock"[\s\S]*flock --exclusive --timeout 300 9/);
    assert.ok(route.indexOf('flock --exclusive') < route.indexOf('--prepare'));
    assert.match(route, /export CLUED_G4_START_LOCK_FD=9/);
    assert.match(route, /--cleanup/);
    assert.equal(route.includes('supabase stop'), false, 'cleanup must never invoke the CLI global prune');
    assert.match(route, /Preserve this attempt's safe allocation and cleanup diagnostics/);
    assert.match(route, /uses: \.\/\.github\/actions\/ci-temporary-storage/);
  }
});

const listen = async (port, host = '0.0.0.0') => {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true, ipv6Only: true }, resolve);
  });
  return server;
};
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('PORT1: a real occupied inbucket port changes the prepared block and remains verifiable', async () => {
  let f, occupied, selected;
  try {
    // Acquire only our own fixture listener. Existing runner services are
    // neither a test failure nor resources this test may close.
    for (let offset = 0; offset < PORT_BLOCK_LIMIT; offset++) {
      const run = 38151441285 + offset;
      const candidateEnv = { ...env, GITHUB_RUN_ID: String(run), GITHUB_RUN_ATTEMPT: '2' };
      const base = portCandidates(candidateEnv)[0];
      try {
        occupied = await listen(base + 4);
        selected = { run, base, port: base + 4 };
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    assert.ok(selected, 'a bounded test-owned occupied-port fixture is required');
    f = workflowFixture(selected.run, 2);
    delete f.runtime.portProbe; // The real default Node exclusive TCP probe.
    const result = await prepare(f.e, f.runtime);
    const actual = fs.readFileSync(path.join(f.app, 'config.toml'), 'utf8');
    assert.doesNotMatch(actual, new RegExp(`port = ${selected.port}(?:\\n|$)`), 'the occupied preferred block cannot be selected');
    assert.ok(portCandidates(f.e).includes(result.port_base));
    assert.notEqual(result.port_base, selected.base);
    const marker = verifyConfiguration(f.e, f.runtime).marker;
    assert.equal(marker.port_base, result.port_base);
    assert.equal(actual, freshConfig(config, f.e, marker.port_base));
    assert.equal(verify(f.e, f.runtime).history_matches, true);
  } finally {
    try { if (occupied) await close(occupied); }
    finally { f?.dispose(); }
  }
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

test('an actual IPv6-only listener excludes its port and releases the partial IPv4 probe', async () => {
  const occupied = await listen(0, '::'), used = occupied.address().port;
  try {
    // IPv4 really is free: the old IPv4-only implementation missed this case.
    const v4 = await listen(used); await close(v4);
    assert.equal(await probePorts([used]), false);
    const released = await listen(used); await close(released);
  } finally { await close(occupied); }
  assert.equal(await probePorts([used]), true);
});

test('unobservable address families fail closed with fixed diagnostics and release partial probes', async () => {
  for (const failedHost of ['0.0.0.0', '::']) for (const code of ['EAFNOSUPPORT', 'EACCES', 'EADDRNOTAVAIL']) {
    const fixture = await listen(0), port = fixture.address().port; await close(fixture);
    const options = [];
    const createListener = callback => {
      const fake = new EventEmitter();
      fake.listen = value => {
        options.push(value);
        queueMicrotask(() => fake.emit('error', Object.assign(new Error('private raw diagnostic'), { code })));
      };
      const real = createServer(callback), originalListen = real.listen.bind(real);
      real.listen = value => value.host === failedHost ? fake.listen(value) : originalListen(value);
      // Failed bind events belong to the server whose handlers the probe owns.
      fake.on('error', error => real.emit('error', error));
      return real;
    };
    await assert.rejects(() => probePorts([port], createListener), error =>
      error.message === (failedHost === '::' ? 'fresh_ipv6_probe_unavailable' : 'fresh_ipv4_probe_unavailable'));
    assert.equal(options.length, 1);
    assert.deepEqual(options[0], { host: failedHost, port, exclusive: true, ipv6Only: true });
    const released = await listen(port); await close(released);
    const released6 = await listen(port, '::'); await close(released6);
  }
});

test('PORT3: selection is bounded and unknown or failed probes cannot write preparation', async () => {
  for (const outcome of [false, undefined, new Error('EACCES')]) {
    const f = workflowFixture(121); let probes = 0;
    try {
      await assert.rejects(() => prepare(f.e, { ...f.runtime, portProbe: async ports => {
        probes++; assert.equal(ports.length, 8); assert.equal(new Set(ports).size, 8);
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
    for (const mutate of [m => delete m.port_base, m => m.port_base = '17968', m => m.port_base = 16000,
      m => m.port_base++, m => m.checkout_sha = 'b'.repeat(40), m => m.project = 'foreign',
      m => m.prepared = false, m => m.source_config_sha256 = '0'.repeat(64), m => m.config_sha256 = '0'.repeat(64),
      m => m.ports['edge_runtime.inspector_port']++, m => m.daemon_id = 'foreign-daemon']) {
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
  for (const base of [null, '17600', 15984, 32000, 17605, NaN, Infinity])
    assert.throws(() => freshConfig(config, env, base), /fresh_port_base/);
  assert.match(freshConfig(config, env, 17632), /port = 17633/);
  const candidates = portCandidates({ ...env, GITHUB_RUN_ID: '999' });
  assert.equal(candidates.length, PORT_BLOCK_LIMIT); assert.equal(new Set(candidates).size, PORT_BLOCK_LIMIT);
  assert.deepEqual(candidates.slice(0, 2), [31984, 16000]);
});

test('all eight real listeners and explicitly enabled SMTP/POP3/vector ports have distinct slots', () => {
  const base = portCandidates(env)[0];
  const optional = config.replace('[local_smtp]\nport = 54324', '[local_smtp]\nport = 54324\nsmtp_port = 54325\npop3_port = 54326')
    .replace('[analytics]\nport = 54327', '[analytics]\nport = 54327\nvector_port = 54328') +
    '[auth.email.smtp]\nport = 587\n';
  const ports = freshPortMap(optional, base), rendered = freshConfig(optional, env, base);
  assert.equal(Object.keys(ports).length, 11); assert.equal(new Set(Object.values(ports)).size, 11);
  assert.equal(ports['edge_runtime.inspector_port'], base + 10);
  assert.equal(ports['local_smtp.smtp_port'], base + 5); assert.equal(ports['analytics.vector_port'], base + 8);
  assert.match(rendered, /\[auth.email.smtp\]\nport = 587\n/);
  for (const changed of [config.replace('inspector_port = 8083\n', ''), config.replace('inspector_port = 8083', 'inspector_port = 8084'),
    config.replace('inspector_port = 8083', 'inspector_port = "env(UNKNOWN)"'), config + '[new_service]\nport = 54328\n',
    config.replace('port = 54324', 'port = 54324\nport = 54324')]) assert.throws(() => freshConfig(changed, env));
});

test('actual Linux ephemeral and reserved ranges are parsed strictly without modifying sysctl', () => {
  assert.deepEqual(parsePortPolicy('32768\t60999\n', ''), { ephemeral: [32768, 60999], reserved: [] });
  assert.deepEqual(parsePortPolicy('10240 65535\n', '1000,2000-3000\n'), { ephemeral: [10240, 65535], reserved: [[1000, 1000], [2000, 3000]] });
  for (const value of ['', 'unknown', '60999 32768', '0 65535', '32768 99999']) assert.throws(() => parsePortPolicy(value, ''));
  for (const value of ['0', '5-3', '70000', '1,', '1-2-3', '1,unknown']) assert.throws(() => parsePortPolicy('32768 60999', value));
});

test('Docker-published ports deny a block even when the TCP probe would report it free', async () => {
  const f = workflowFixture(124), first = portCandidates(f.e)[0], id = 'd'.repeat(64), probed = [];
  try {
    const result = await prepare(f.e, { ...f.runtime,
      portProbe: async ports => { probed.push(ports); return true; }, docker: (...args) => {
        if (args[0] === 'ps' && args.includes('-q')) return id + '\n';
        if (args[0] === 'inspect' && args.includes('{{json .NetworkSettings.Ports}}'))
          return JSON.stringify({ '8025/tcp': [{ HostIp: '0.0.0.0', HostPort: String(first + 4) }] });
        return f.runtime.docker(...args);
      } });
    assert.equal(result.port_base, portCandidates(f.e)[1]);
    assert.equal(probed.length, 1); assert.equal(probed[0].includes(first + 4), false);
    assert.equal(result.ports['edge_runtime.inspector_port'], result.port_base + 10);
  } finally { f.dispose(); }
});

test('failed Docker publishing observation cannot be treated as an empty port inventory', async () => {
  for (const malformed of [false, true]) {
    const f = workflowFixture(134);
    try {
      await assert.rejects(() => prepare(f.e, { ...f.runtime, docker: (...args) => {
        if (args[0] === 'ps' && args.includes('-q')) return 'd'.repeat(64);
        if (args[0] === 'inspect' && args.includes('{{json .NetworkSettings.Ports}}')) {
          if (malformed) return 'not valid JSON';
          throw Error('daemon inventory unavailable');
        }
        return f.runtime.docker(...args);
      } }));
      assert.equal(fs.existsSync(f.e.GITHUB_ENV), false);
      assert.equal(fs.readFileSync(path.join(f.app, 'config.toml'), 'utf8'), config);
    } finally { f.dispose(); }
  }
});

test('selection skips the complete actual ephemeral/reserved ranges and remains bounded', async () => {
  for (const exhausted of [false, true]) {
    const f = workflowFixture(125), blocks = portCandidates(f.e);
    try {
      const pending = prepare(f.e, { ...f.runtime, portPolicy: () => ({ ephemeral: exhausted ? [1, 65535] : [blocks[0], blocks[0] + 15],
        reserved: [[blocks[1] + 10, blocks[1] + 10]] }) });
      if (exhausted) {
        await assert.rejects(pending, /fresh_no_available_port_block/);
        assert.equal(fs.existsSync(f.e.GITHUB_ENV), false);
      } else assert.equal((await pending).port_base, blocks[2]);
    } finally { f.dispose(); }
  }
});

test('unproved startup lock and malformed Docker publishing cannot prepare a project', async () => {
  const f = workflowFixture(126);
  try {
    await assert.rejects(() => prepare(f.e, { ...f.runtime, startLock: () => { throw Error('fresh_start_lock_required'); } }), /fresh_start_lock_required/);
    assert.equal(fs.existsSync(f.e.GITHUB_ENV), false);
    assert.throws(() => publishedPorts('{"80/tcp":[{"HostPort":"unknown"}]}'), /fresh_docker_ports_unknown/);
    assert.throws(() => publishedPorts('{"80/tcp":{"HostPort":"8080"}}'), /fresh_docker_ports_unknown/);
    assert.deepEqual([...publishedPorts('null\n{}\n{"80/tcp":[{"HostPort":"8080"},{"HostPort":"8080"}]}')], [8080]);
    assert.equal(startupLockPath('fixture-shared-daemon'), startupLockPath('fixture-shared-daemon'));
    assert.notEqual(startupLockPath('fixture-shared-daemon'), startupLockPath('fixture-other-daemon'));
    assert.throws(() => startupLockPath('../untrusted/path'), /fresh_docker_identity_unknown/);
  } finally { f.dispose(); }
});

function cleanupWorld(f, { foreignLabel = false, stopFails = false, stopError, stopStaysRunning = false, networkFails = false } = {}) {
  const project = f.e.CLUED_G4_FRESH_PROJECT;
  const own = { container: [{ id: 'a'.repeat(64), name: `supabase_db_${project}`, project, running: true }],
    network: [{ id: 'b'.repeat(64), name: `supabase_network_${project}`, project: foreignLabel ? 'foreign' : project }],
    volume: [{ id: `supabase_db_${project}`, name: `supabase_db_${project}`, project }] };
  const foreign = Object.fromEntries(Object.keys(own).map(kind => [kind,
    { id: kind === 'volume' ? 'supabase_db_foreign' : 'f'.repeat(64), name: `supabase_${kind}_foreign`, project: 'foreign', running: true }]));
  const calls = [], mutations = [];
  const docker = (...args) => {
    calls.push(args);
    if (args[0] === 'context' || args[0] === 'info') return f.runtime.docker(...args);
    const kind = args[0] === 'network' || args[0] === 'volume' ? args[0] : 'container';
    if (args.includes('--format') && (args[0] === 'ps' || args[1] === 'ls'))
      return [...own[kind], foreign[kind]].map(({ id, name, project }) => JSON.stringify({ id, name, project })).join('\n');
    if (args[0] === 'inspect' || args[1] === 'inspect') {
      const row = [...own[kind], foreign[kind]].find(row => row.id === args.at(-1));
      assert.ok(row, 'a removed or unknown resource cannot be inspected as owned');
      return JSON.stringify({ ...row, name: (kind === 'container' ? '/' : '') + row.name });
    }
    if (args[0] === 'stop') {
      mutations.push(args); if (stopError) throw stopError;
      if (stopFails) throw Error('private docker failure must not become a diagnostic');
      if (!stopStaysRunning) own.container.find(row => row.id === args.at(-1)).running = false;
      return args.at(-1);
    }
    if (args[0] === 'rm' || args[1] === 'rm') {
      mutations.push(args); if (kind === 'network' && networkFails) throw Error('network is used by another container');
      const index = own[kind].findIndex(row => row.id === args.at(-1));
      assert.notEqual(index, -1, 'foreign resources are never removal targets'); own[kind].splice(index, 1);
      return args.at(-1);
    }
    return f.runtime.docker(...args);
  };
  return { own, foreign, calls, mutations, runtime: { ...f.runtime, docker } };
}

test('exact cleanup removes only this project, without global prune or forced removal', async () => {
  const f = workflowFixture(127);
  try {
    await prepare(f.e, f.runtime); const world = cleanupWorld(f);
    const result = cleanup(f.e, world.runtime);
    assert.deepEqual(result.removed, { container: 1, network: 1, volume: 1 });
    assert.equal(result.status, 'completed'); assert.ok(Object.values(world.own).every(rows => rows.length === 0));
    assert.equal(Object.keys(world.foreign).length, 3);
    assert.equal(world.calls.some(args => args.includes('prune') || args.includes('--force') || args.includes('-f')), false);
    assert.deepEqual(world.mutations.map(args => args.at(-1)), ['a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64), `supabase_db_${f.e.CLUED_G4_FRESH_PROJECT}`]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'clued-g4-fresh-127-1.json'), 'utf8')).cleanup.status, 'completed');
  } finally { f.dispose(); }
});

test('a mismatched project label fails the whole cleanup preflight before any resource stops', async () => {
  const f = workflowFixture(128);
  try {
    await prepare(f.e, f.runtime); const world = cleanupWorld(f, { foreignLabel: true });
    assert.throws(() => cleanup(f.e, world.runtime), /fresh_cleanup_identity/); assert.deepEqual(world.mutations, []);
    const marker = JSON.parse(fs.readFileSync(path.join(f.root, 'clued-g4-fresh-128-1.json'), 'utf8'));
    assert.deepEqual(marker.cleanup, { status: 'failed', reason_code: 'fresh_cleanup_identity' });
  } finally { f.dispose(); }
});

test('failed or unproven container exit preserves the resources and a fixed safe diagnosis', async () => {
  for (const [options, reason] of [[{ stopFails: true }, 'fresh_cleanup_container_stop_failed'],
    [{ stopStaysRunning: true }, 'fresh_cleanup_container_still_running']]) {
    const f = workflowFixture(129);
    try {
      await prepare(f.e, f.runtime); const world = cleanupWorld(f, options);
      assert.throws(() => cleanup(f.e, world.runtime), new RegExp(reason));
      assert.equal(world.mutations.length, 1); assert.equal(world.own.container.length, 1);
      assert.equal(world.own.network.length, 1); assert.equal(world.own.volume.length, 1);
      const marker = fs.readFileSync(path.join(f.root, 'clued-g4-fresh-129-1.json'), 'utf8');
      assert.equal(JSON.parse(marker).cleanup.reason_code, reason); assert.doesNotMatch(marker, /private docker failure/);
    } finally { f.dispose(); }
  }
});

test('cleanup distinguishes bounded child failures without disclosing Docker output or accepting untrusted fields', async () => {
  const cases = [
    [{ status: 1 }, { status: 1 }],
    [{ status: null, signal: 'SIGTERM', code: 'ETIMEDOUT' }, { signal: 'SIGTERM', code: 'ETIMEDOUT' }],
    [{ status: null, signal: 'SIGKILL' }, { signal: 'SIGKILL' }],
    [{ code: 'ENOENT' }, { code: 'ENOENT' }],
    [{ status: '1', signal: 'PRIVATE_SIGNAL', code: 'PRIVATE_CODE' }, undefined],
    [{ status: -1, code: 'PRIVATE_CODE' }, undefined],
    [{ status: 256 }, undefined],
    [{ child_failure: { status: 2, stderr: 'PRIVATE_STDERR', token: 'PRIVATE_TOKEN' } }, { status: 2 }],
  ];
  for (const [fields, expected] of cases) {
    const f = workflowFixture(132);
    try {
      await prepare(f.e, f.runtime);
      const stopError = Object.assign(Error('PRIVATE_MESSAGE'), {
        stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR', spawnargs: ['PRIVATE_ARGUMENT'], ...fields,
      });
      const world = cleanupWorld(f, { stopError });
      assert.throws(() => cleanup(f.e, world.runtime), /fresh_cleanup_container_stop_failed/);
      const marker = fs.readFileSync(path.join(f.root, 'clued-g4-fresh-132-1.json'), 'utf8');
      const failure = JSON.parse(marker).cleanup;
      assert.equal(failure.status, 'failed');
      assert.equal(failure.reason_code, 'fresh_cleanup_container_stop_failed');
      assert.deepEqual(failure.child_failure, expected);
      assert.doesNotMatch(marker, /PRIVATE_/);
      assert.equal(world.mutations.length, 1, 'no retry, forced removal or later cleanup follows a failed stop');
      assert.deepEqual(Object.values(world.own).map(rows => rows.length), [1, 1, 1]);
    } finally { f.dispose(); }
  }
});

test('diagnostic metadata never executes accessors or lets reflection failures replace the fixed error', async () => {
  const accessorError = key => Object.defineProperty(Error('private_sensitive_message'), key,
    { get() { throw Error('fresh_private_sensitive_getter'); } });
  const nested = Error('private_sensitive_message');
  nested.child_failure = Object.defineProperty({}, 'status', { get() { throw Error('fresh_private_sensitive_getter'); } });
  const proxy = Error('private_sensitive_message');
  proxy.child_failure = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('fresh_private_sensitive_proxy'); } });
  for (const stopError of ['child_failure', 'status', 'signal', 'code'].map(accessorError).concat([nested, proxy])) {
    const f = workflowFixture(134);
    try {
      await prepare(f.e, f.runtime);
      const world = cleanupWorld(f, { stopError });
      assert.throws(() => cleanup(f.e, world.runtime), /fresh_cleanup_container_stop_failed/);
      const marker = fs.readFileSync(path.join(f.root, 'clued-g4-fresh-134-1.json'), 'utf8');
      assert.deepEqual(JSON.parse(marker).cleanup, { status: 'failed', reason_code: 'fresh_cleanup_container_stop_failed' });
      assert.doesNotMatch(marker, /private_sensitive|child_failure/);
      assert.equal(world.mutations.length, 1);
    } finally { f.dispose(); }
  }
});

test('actual child exit and timeout reach cleanup diagnostics without retaining private output', async () => {
  for (const timeout of [false, true]) {
    let childError;
    try {
      execFileSync(process.execPath, ['-e', timeout
        ? "process.stderr.write('PRIVATE_REAL_STDERR');setInterval(()=>{},50)"
        : "process.stderr.write('PRIVATE_REAL_STDERR');process.exit(7)"],
      { stdio: 'pipe', timeout: timeout ? 150 : 3000, windowsHide: true });
    } catch (error) { childError = error; }
    assert.ok(childError);
    if (timeout) assert.equal(childError.code, 'ETIMEDOUT');
    else assert.equal(childError.status, 7);
    const f = workflowFixture(133);
    try {
      await prepare(f.e, f.runtime);
      const world = cleanupWorld(f, { stopError: childError });
      assert.throws(() => cleanup(f.e, world.runtime), /fresh_cleanup_container_stop_failed/);
      const marker = fs.readFileSync(path.join(f.root, 'clued-g4-fresh-133-1.json'), 'utf8');
      const detail = JSON.parse(marker).cleanup.child_failure;
      if (timeout) assert.equal(detail.code, 'ETIMEDOUT');
      else assert.equal(detail.status, 7);
      assert.doesNotMatch(marker, /PRIVATE_REAL_STDERR|spawnargs|stderr|stdout/);
      assert.equal(world.mutations.length, 1);
    } finally { f.dispose(); }
  }
});

test('a network still in use is preserved and no volume or foreign resource is force-removed', async () => {
  const f = workflowFixture(130);
  try {
    await prepare(f.e, f.runtime); const world = cleanupWorld(f, { networkFails: true });
    assert.throws(() => cleanup(f.e, world.runtime), /fresh_cleanup_network_remove_failed/);
    assert.equal(world.own.network.length, 1); assert.equal(world.own.volume.length, 1);
    assert.equal(world.mutations.some(args => args[0] === 'volume'), false);
  } finally { f.dispose(); }
});

test('failed or malformed cleanup inventory is unknown, never an empty list permitting mutation', async () => {
  for (const malformed of [false, true]) {
    const f = workflowFixture(131);
    try {
      await prepare(f.e, f.runtime); const world = cleanupWorld(f), delegate = world.runtime.docker;
      world.runtime.docker = (...args) => {
        if (args[0] === 'network' && args[1] === 'ls') {
          if (malformed) return 'not valid JSON';
          throw Error('private inventory failure');
        }
        return delegate(...args);
      };
      assert.throws(() => cleanup(f.e, world.runtime), /fresh_cleanup_inventory_unknown/);
      assert.deepEqual(world.mutations, []);
      const marker = fs.readFileSync(path.join(f.root, 'clued-g4-fresh-131-1.json'), 'utf8');
      assert.equal(JSON.parse(marker).cleanup.reason_code, 'fresh_cleanup_inventory_unknown');
      assert.doesNotMatch(marker, /private inventory failure/);
    } finally { f.dispose(); }
  }
});

test('an unknown label or identity change at inspect preserves the entire cleanup plan', async () => {
  for (const mode of ['unknown_label', 'changed_id']) {
    const f = workflowFixture(132);
    try {
      await prepare(f.e, f.runtime); const world = cleanupWorld(f), delegate = world.runtime.docker;
      if (mode === 'unknown_label') world.own.network[0].project = null;
      else world.runtime.docker = (...args) => {
        const answer = delegate(...args);
        return args[0] === 'network' && args[1] === 'inspect' ? JSON.stringify({ ...JSON.parse(answer), id: 'e'.repeat(64) }) : answer;
      };
      assert.throws(() => cleanup(f.e, world.runtime), /fresh_cleanup_identity/);
      assert.deepEqual(world.mutations, []);
    } finally { f.dispose(); }
  }
});

test('post-start inspection rejects a real published host port missing from the prepared mapping', async () => {
  const f = workflowFixture(133);
  try {
    await prepare(f.e, f.runtime);
    assert.throws(() => verify(f.e, { ...f.runtime, docker: (...args) =>
      args[0] === 'inspect' && args.includes('{{json .NetworkSettings.Ports}}') ?
        JSON.stringify({ '8083/tcp': [{ HostIp: '0.0.0.0', HostPort: '8083' }] }) : f.runtime.docker(...args) }), /fresh_unmapped_host_port/);
    assert.equal(f.calls.some(args => args[0] === 'exec'), false, 'no history acceptance follows an untracked listener');
  } finally { f.dispose(); }
});

const moduleURL = process.env.CLUED_G4_TEST_MODULE_PATH ? pathToFileURL(process.env.CLUED_G4_TEST_MODULE_PATH).href : new URL('./clued-g4-fresh-start.mjs', import.meta.url).href;
const lockChild = `
import fs from 'node:fs';
import { verifyStartupLock } from ${JSON.stringify(moduleURL)};
const [daemon, ledger, slot, mode] = process.argv.slice(1);
verifyStartupLock(daemon);
const write = phase => fs.appendFileSync(ledger, JSON.stringify({phase,slot})+'\\n');
write('entered');process.stdout.write(JSON.stringify({phase:'entered'})+'\\n');
if(mode==='hold')await new Promise(resolve=>process.stdin.once('data',resolve));
write('exited');
if(mode==='testing'){
 fs.closeSync(9);process.stdout.write(JSON.stringify({phase:'testing'})+'\\n');
 await new Promise(resolve=>process.stdin.once('data',resolve));
}
`;
function flockFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-flock-test-')), daemon = `g4-test-${randomUUID()}`;
  const lock = startupLockPath(daemon), ledger = path.join(root, 'events.jsonl'), children = [];
  fs.writeFileSync(ledger, '');
  const launch = (slot, mode = 'complete', wait = '5') => {
    const runnerTemp = path.join(root, `runner-${slot}`); fs.mkdirSync(runnerTemp);
    const script = 'umask 077; exec 9>>"$1"; printf \'{"phase":"waiting"}\\n\'; flock --exclusive --conflict-exit-code 75 --timeout "$2" 9 || exit $?; export CLUED_G4_START_LOCK_FD=9; exec "$3" --input-type=module -e "$4" "$5" "$6" "$7" "$8"';
    const child = spawn('bash', ['-c', script, 'g4-owned-fixture', lock, wait, process.execPath, lockChild, daemon, ledger, slot, mode], {
      cwd: runnerTemp, env: { ...process.env, RUNNER_TEMP: runnerTemp }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = ''; const pending = [];
    const deadline = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', bytes => {
      stdout += bytes;
      for (const item of pending) if (stdout.includes(`"phase":"${item.phase}"`)) item.resolve();
    });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const done = new Promise((resolve, reject) => {
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        for (const item of pending) item.reject(new Error(`child closed before ${item.phase}: ${JSON.stringify({ code, signal, stdout, stderr })}`));
        resolve({ code, signal, stdout, stderr });
      });
    });
    const result = { child, done, output: () => stdout, waitFor: phase => stdout.includes(`"phase":"${phase}"`) ? Promise.resolve() :
      new Promise((resolve, reject) => pending.push({ phase, resolve, reject })) };
    children.push(result); return result;
  };
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled(children.map(item => item.done));
    fs.rmSync(root, { recursive: true });
    if (fs.existsSync(lock)) fs.unlinkSync(lock); // This UUID fixture's own lock only.
  });
  return { launch, ledger };
}

test('Linux: independent runner workspaces share one daemon startup lock', { skip: process.platform !== 'linux' }, async t => {
  const f = flockFixture(t), first = f.launch('one', 'hold'); await first.waitFor('entered');
  const second = f.launch('two'); await second.waitFor('waiting');
  assert.doesNotMatch(second.output(), /"phase":"entered"/, 'the second runner cannot cross the probe/publish handoff');
  first.child.stdin.end('published');
  for (const child of [first, second]) { const result = await child.done; assert.equal(result.code, 0, JSON.stringify(result)); }
  assert.deepEqual(fs.readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse), [
    { phase: 'entered', slot: 'one' }, { phase: 'exited', slot: 'one' },
    { phase: 'entered', slot: 'two' }, { phase: 'exited', slot: 'two' },
  ]);
});

test('Linux: two existing stacks can run tests concurrently after their startup handoff', { skip: process.platform !== 'linux' }, async t => {
  const f = flockFixture(t), first = f.launch('one', 'testing'); await first.waitFor('testing');
  const second = f.launch('two', 'testing'); await second.waitFor('testing');
  assert.equal(first.child.exitCode, null); assert.equal(second.child.exitCode, null);
  for (const child of [first, second]) child.child.stdin.end('tests complete');
  for (const child of [first, second]) { const result = await child.done; assert.equal(result.code, 0, JSON.stringify(result)); }
});

test('Linux: a bounded lock waiter fails without stealing or releasing the live holder', { skip: process.platform !== 'linux' }, async t => {
  const f = flockFixture(t), first = f.launch('one', 'hold'); await first.waitFor('entered');
  const waiting = f.launch('two', 'complete', '0.1'), result = await waiting.done;
  assert.equal(result.code, 75, JSON.stringify(result)); assert.doesNotMatch(result.stdout, /"phase":"entered"/);
  assert.equal(first.child.exitCode, null); first.child.stdin.end('published');
  assert.equal((await first.done).code, 0);
  const next = await f.launch('three').done; assert.equal(next.code, 0, JSON.stringify(next));
});

test('Linux: abrupt owned holder exit releases its kernel lock without a stale PID file', { skip: process.platform !== 'linux' }, async t => {
  const f = flockFixture(t), first = f.launch('one', 'hold'); await first.waitFor('entered');
  first.child.kill('SIGKILL'); const killed = await first.done; assert.equal(killed.signal, 'SIGKILL');
  const next = await f.launch('two').done; assert.equal(next.code, 0, JSON.stringify(next));
  assert.deepEqual(fs.readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse), [
    { phase: 'entered', slot: 'one' }, { phase: 'entered', slot: 'two' }, { phase: 'exited', slot: 'two' },
  ]);
});
