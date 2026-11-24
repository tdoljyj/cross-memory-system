import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

const CONFIG = 'apps/clued-cloud/supabase/config.toml';
const SOCKET = 'unix:///var/run/docker.sock';
const SHA = /^[a-f0-9]{40}$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const need = (value, code) => { if (!value) throw new Error(code); };
const defaultGit = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const defaultDocker = (...args) => execFileSync('docker', ['--host', SOCKET, ...args], {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
});

export function identity(env) {
  const run = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT);
  need(Number.isSafeInteger(run) && run > 0 && Number.isSafeInteger(attempt) && attempt > 0 &&
    SHA.test(env.GITHUB_SHA ?? '') && /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? ''), 'fresh_identity');
  return { run_id: run, run_attempt: attempt, repository: env.GITHUB_REPOSITORY,
    checkout_sha: env.GITHUB_SHA, project: `clued-g4-${run}-${attempt}` };
}

export const PORT_BLOCK_LIMIT = 16;
const PORT_FIRST = 16000, PORT_SLOTS = 1000, PORT_STRIDE = 16;
// These are host listeners, not outbound auth.email.smtp.port. Optional
// listeners must be explicit in the source before they can be enabled here.
const PORT_FIELDS = Object.freeze({
  'db.shadow_port': [54320, 0], 'api.port': [54321, 1], 'db.port': [54322, 2],
  'studio.port': [54323, 3], 'local_smtp.port': [54324, 4],
  'local_smtp.smtp_port': [54325, 5], 'local_smtp.pop3_port': [54326, 6],
  'analytics.port': [54327, 7], 'analytics.vector_port': [54328, 8],
  'db.pooler.port': [54329, 9], 'edge_runtime.inspector_port': [8083, 10],
});
const REQUIRED_PORTS = Object.keys(PORT_FIELDS).filter(key =>
  !['local_smtp.smtp_port', 'local_smtp.pop3_port', 'analytics.vector_port'].includes(key));
export function portCandidates(env) {
  const id = identity(env);
  const index = (id.run_id % PORT_SLOTS + (id.run_attempt - 1) % PORT_SLOTS) % PORT_SLOTS;
  return Array.from({ length: PORT_BLOCK_LIMIT }, (_, offset) => PORT_FIRST + ((index + offset) % PORT_SLOTS) * PORT_STRIDE);
}
const validBase = (base) => Number.isSafeInteger(base) && base >= PORT_FIRST &&
  base < PORT_FIRST + PORT_SLOTS * PORT_STRIDE && (base - PORT_FIRST) % PORT_STRIDE === 0;

function rewritePorts(source, base) {
  let section = '';
  const seen = new Set(), ports = {};
  const text = source.replace(/[^\n]*(?:\n|$)/g, line => {
    const table = /^[ \t]*\[([a-z0-9_.]+)\][ \t]*(?:#[^\r\n]*)?\r?\n?$/.exec(line);
    if (table) section = table[1];
    const assignment = /^[ \t]*([a-z0-9_]*port)[ \t]*=/.exec(line);
    if (!assignment) return line;
    const field = `${section}.${assignment[1]}`;
    if (field === 'auth.email.smtp.port') return line; // An external destination.
    need(Object.hasOwn(PORT_FIELDS, field) && !seen.has(field), 'fresh_port_layout_changed');
    const value = /^([ \t]*[a-z0-9_]*port[ \t]*=[ \t]*)([0-9]+)([ \t]*(?:#[^\r\n]*)?\r?\n?)$/.exec(line);
    need(value && Number(value[2]) === PORT_FIELDS[field][0], 'fresh_port_layout_changed');
    seen.add(field); ports[field] = base + PORT_FIELDS[field][1];
    return value[1] + ports[field] + value[3];
  });
  need(REQUIRED_PORTS.every(field => seen.has(field)), 'fresh_complete_ports_required');
  return { text, ports };
}

export function freshPortMap(source, base) {
  need(validBase(base), 'fresh_port_base');
  return rewritePorts(source, base).ports;
}

export function freshConfig(source, env, base = portCandidates(env)[0]) {
  const id = identity(env);
  need(validBase(base), 'fresh_port_base');
  need(source.split('project_id = "clued-cloud"').length === 2, 'fresh_project_source');
  const seed = /^\[db\.seed\][ \t]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(source)?.[1];
  need(seed && /^[ \t]*enabled[ \t]*=[ \t]*false[ \t]*$/m.test(seed), 'fresh_seed_must_be_disabled');
  // Preserve source settings and comments; every host listener has one slot.
  return rewritePorts(source.replace('project_id = "clued-cloud"', `project_id = "${id.project}"`), base).text;
}

export function parsePortPolicy(ephemeral, reserved) {
  need(typeof ephemeral === 'string' && typeof reserved === 'string', 'fresh_port_policy_unknown');
  const range = /^([0-9]+)[ \t]+([0-9]+)\s*$/.exec(ephemeral);
  need(range && Number(range[1]) > 0 && Number(range[2]) <= 65535 && Number(range[1]) <= Number(range[2]), 'fresh_ephemeral_range_unknown');
  const excluded = reserved.trim() === '' ? [] : reserved.trim().split(',').map(value => {
    const match = /^([0-9]+)(?:-([0-9]+))?$/.exec(value);
    need(match, 'fresh_reserved_ports_unknown');
    const low = Number(match[1]), high = Number(match[2] ?? match[1]);
    need(low > 0 && high <= 65535 && low <= high, 'fresh_reserved_ports_unknown');
    return [low, high];
  });
  return { ephemeral: [Number(range[1]), Number(range[2])], reserved: excluded };
}

export function publishedPorts(text) {
  const ports = new Set();
  for (const line of lines(text)) {
    let bindings;
    try { bindings = JSON.parse(line); } catch { throw new Error('fresh_docker_ports_unknown'); }
    if (bindings === null) continue; // Docker containers with no host publishing.
    need(bindings && typeof bindings === 'object' && !Array.isArray(bindings), 'fresh_docker_ports_unknown');
    for (const [key, values] of Object.entries(bindings)) {
      need(/^[0-9]+\/(?:tcp|udp)$/.test(key) && (values === null || Array.isArray(values)), 'fresh_docker_ports_unknown');
      for (const value of values ?? []) {
        need(value && typeof value.HostPort === 'string' && /^[0-9]+$/.test(value.HostPort) &&
          Number(value.HostPort) > 0 && Number(value.HostPort) <= 65535, 'fresh_docker_ports_unknown');
        ports.add(Number(value.HostPort));
      }
    }
  }
  return ports;
}

export function startupLockPath(daemon) {
  need(typeof daemon === 'string' && /^[a-zA-Z0-9:_-]{8,200}$/.test(daemon), 'fresh_docker_identity_unknown');
  // Qualified topology: native runners of one local daemon share /tmp (the
  // current company CluedCI-Linux slots were checked via mount namespace and
  // directory inode). An equal daemon ID through a cross-namespace proxy is
  // not evidence of shared locking; such a topology needs qualification first.
  return `/tmp/clued-g4-docker-${hash(daemon).slice(0, 24)}.lock`;
}

// FD 9 is inherited from the workflow's flock, across prepare/start/verify.
// fdinfo proves this same open file description holds an exclusive lock.
export function verifyStartupLock(daemon, env = process.env, filesystem = fs) {
  need(env.CLUED_G4_START_LOCK_FD === '9', 'fresh_start_lock_required');
  const file = startupLockPath(daemon), descriptor = filesystem.fstatSync(9), named = filesystem.lstatSync(file);
  need(named.isFile() && !named.isSymbolicLink() && descriptor.isFile() &&
    descriptor.dev === named.dev && descriptor.ino === named.ino && named.nlink === 1 &&
    named.uid === process.getuid() && (named.mode & 0o022) === 0 &&
    /^lock:\s+\S+: FLOCK\s+ADVISORY\s+WRITE\s+/m.test(filesystem.readFileSync('/proc/self/fdinfo/9', 'utf8')), 'fresh_start_lock_unproven');
}

export async function probePorts(ports, createListener = createServer) {
  need(Array.isArray(ports) && ports.length > 0 && ports.length <= Object.keys(PORT_FIELDS).length &&
    new Set(ports).size === ports.length && ports.every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535), 'fresh_probe_ports');
  const servers = [];
  try {
    // Docker can publish both address families. Separate IPv6-only sockets
    // detect a non-Docker IPv6 listener without colliding with our IPv4 probe.
    // A host that cannot prove both families available is not qualified here.
    for (const port of ports) for (const host of ['0.0.0.0', '::']) {
      const server = createListener(socket => socket.destroy());
      servers.push(server);
      try {
        await new Promise((resolve, reject) => {
          const error = cause => { server.off('listening', listening); reject(cause); };
          const listening = () => { server.off('error', error); resolve(); };
          server.once('error', error); server.once('listening', listening);
          server.listen({ host, port, exclusive: true, ipv6Only: true });
        });
      } catch (error) {
        if (error.code === 'EADDRINUSE') return false;
        throw new Error(host === '::' ? 'fresh_ipv6_probe_unavailable' : 'fresh_ipv4_probe_unavailable');
      }
    }
    return true;
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server =>
      new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
}

export function requireUnused({ labelledContainers, labelledVolumes, volumeNames, containerNames }, project) {
  need(Array.isArray(labelledContainers) && Array.isArray(labelledVolumes) && Array.isArray(volumeNames) &&
    Array.isArray(containerNames), 'fresh_inventory_unknown');
  need(labelledContainers.length === 0 && labelledVolumes.length === 0 &&
    !volumeNames.includes(`supabase_db_${project}`) &&
    !containerNames.some((name) => name.replace(/^\//, '').startsWith('supabase_') &&
      name.endsWith(`_${project}`)), 'fresh_project_already_exists');
}

export function verifySourceState(marker, state) {
  need(marker.prepared === true && state.head === marker.checkout_sha, 'fresh_checkout_changed');
  need(state.dirty.trim() === `M ${CONFIG}`, 'fresh_other_tracked_changes');
}

export function verifyContainer(marker, container, volumeLabels) {
  const expected = `supabase_db_${marker.project}`;
  const data = container.mounts?.filter((mount) => mount.Destination === '/var/lib/postgresql/data');
  need(container.name === `/${expected}` && container.project === marker.project &&
    data?.length === 1 && data[0].Type === 'volume' && data[0].Name === expected &&
    volumeLabels?.['com.supabase.cli.project'] === marker.project, 'fresh_database_container_identity');
}

export function migrationSources(directory) {
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
  need(files.length > 0, 'fresh_migrations_missing');
  const rows = files.map((file) => {
    const match = /^([0-9]{12,14})_([^/\\]+)\.sql$/.exec(file);
    need(match, 'fresh_migration_filename');
    return { file, version: match[1], name: match[2], sha256: hash(fs.readFileSync(path.join(directory, file))) };
  });
  need(new Set(rows.map((row) => row.version)).size === rows.length, 'fresh_duplicate_migration_version');
  return rows;
}

export function verifyHistory(source, history) {
  need(Array.isArray(history) && history.length === source.length &&
    new Set(history.map((row) => row.version)).size === history.length, 'fresh_history_count');
  const actual = new Map(history.map((row) => [row.version, row.name]));
  need(source.every((row) => actual.get(row.version) === row.name), 'fresh_history_mismatch');
  return { migrations: source.length, history_matches: true };
}

function lines(value) { return value.trim().split('\n').filter(Boolean); }
function markerPath(env) {
  const id = identity(env);
  need(env.RUNNER_TEMP && path.isAbsolute(env.RUNNER_TEMP), 'fresh_runner_temp');
  return path.join(env.RUNNER_TEMP, `clued-g4-fresh-${id.run_id}-${id.run_attempt}.json`);
}
function readMarker(env, filesystem = fs) {
  const marker = JSON.parse(filesystem.readFileSync(markerPath(env), 'utf8'));
  verifyMarkerIdentity(marker, env);
  return marker;
}
function verifyMarkerIdentity(marker, env) {
  const id = identity(env);
  need(marker.schema === 'clued.g4.fresh-start/2' && marker.prepared === true &&
    Object.entries(id).every(([key, value]) => marker[key] === value) &&
    validBase(marker.port_base) && portCandidates(env).includes(marker.port_base), 'fresh_marker_identity');
}
// The default marker is read from this exact attempt's host file. Explicit
// marker input is a test boundary, never proof of Owner/source authorization.
export function verifyPreparedConfiguration(source, actual, env, marker = readMarker(env)) {
  verifyMarkerIdentity(marker, env);
  need(marker.source_config_sha256 === hash(source) && marker.config_sha256 === hash(actual) &&
    actual === freshConfig(source, env, marker.port_base) &&
    JSON.stringify(marker.ports) === JSON.stringify(freshPortMap(source, marker.port_base)), 'fresh_configuration_changed');
  return marker;
}
function configAt(root) { return path.join(root, CONFIG); }

function requireLocal(env, runtime) {
  need(runtime.platform === 'linux' && (!env.DOCKER_HOST || env.DOCKER_HOST === SOCKET) &&
    (!env.DOCKER_CONTEXT || env.DOCKER_CONTEXT === 'default'), 'fresh_local_docker_only');
  const endpoint = JSON.parse(runtime.docker('context', 'inspect', 'default', '--format', '{{json .Endpoints.docker.Host}}').trim());
  need(endpoint === SOCKET, 'fresh_default_context_not_local');
  const daemon = JSON.parse(runtime.docker('info', '--format', '{{json .ID}}').trim());
  startupLockPath(daemon); // Validate before this value can select a host lock.
  return daemon;
}

// `supabase start` applies no migration ([db.migrations] enabled = false). The chain is applied here, in
// production's shape, by the one local executor; it connects only to 127.0.0.1 and the [db] port of this
// checkout's prepared config.toml. Its progress goes to stderr: stdout carries only this script's result.
function defaultApplyMigrations(root) {
  execFileSync(process.execPath, [path.join(root, 'scripts/ci/clued-local-migrate.mjs')],
    { cwd: root, stdio: ['ignore', 2, 2] });
}

// Test-only command boundaries; the CLI always uses these fixed host defaults.
const adapters = (overrides = {}) => ({ git: defaultGit, docker: defaultDocker, fs, portProbe: probePorts,
  startLock: verifyStartupLock, applyMigrations: defaultApplyMigrations,
  portPolicy: () => parsePortPolicy(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8'),
    fs.readFileSync('/proc/sys/net/ipv4/ip_local_reserved_ports', 'utf8')),
  platform: process.platform, ...overrides });

export async function prepare(env = process.env, overrides) {
  const runtime = adapters(overrides);
  const { git, docker, fs } = runtime;
  const daemon = requireLocal(env, runtime);
  runtime.startLock(daemon, env, fs);
  const id = identity(env);
  const root = git('rev-parse', '--show-toplevel').trim();
  need(git('rev-parse', 'HEAD').trim() === id.checkout_sha &&
    git('status', '--porcelain', '--untracked-files=no').trim() === '', 'fresh_clean_source_required');
  need(!fs.existsSync(path.join(root, 'apps/clued-cloud/supabase/.temp/project-ref')), 'fresh_linked_project_refused');
  const source = git('show', `HEAD:${CONFIG}`);
  need(fs.readFileSync(configAt(root), 'utf8') === source, 'fresh_config_source_changed');
  freshConfig(source, env);
  const filter = `label=com.supabase.cli.project=${id.project}`;
  requireUnused({
    labelledContainers: lines(docker('ps', '-a', '--filter', filter, '--format', '{{.ID}}')),
    labelledVolumes: lines(docker('volume', 'ls', '--filter', filter, '--format', '{{.Name}}')),
    containerNames: lines(docker('ps', '-a', '--format', '{{.Names}}')),
    // The CLI checks its exact db volume even if an old one has lost its label.
    volumeNames: lines(docker('volume', 'ls', '--format', '{{.Name}}')),
  }, id.project);
  const ids = lines(docker('ps', '-q', '--no-trunc'));
  need(ids.every(value => /^[0-9a-f]{64}$/.test(value)) && ids.length <= 512, 'fresh_docker_ports_unknown');
  const occupied = ids.length ? publishedPorts(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', ...ids)) : new Set();
  const policy = runtime.portPolicy();
  need(Array.isArray(policy?.ephemeral) && Array.isArray(policy?.reserved), 'fresh_port_policy_unknown');
  let config, base, ports;
  for (const candidate of portCandidates(env)) {
    const rendered = freshConfig(source, env, candidate);
    const mapping = freshPortMap(source, candidate), values = Object.values(mapping);
    if (values.some(port => occupied.has(port) || [policy.ephemeral, ...policy.reserved]
      .some(([low, high]) => port >= low && port <= high))) continue;
    const available = await runtime.portProbe(values);
    need(typeof available === 'boolean', 'fresh_probe_unknown');
    if (available) { config = rendered; base = candidate; ports = mapping; break; }
  }
  need(config !== undefined, 'fresh_no_available_port_block');
  // The shared daemon lock remains held by this workflow through start and
  // verify. Other G4 runners cannot choose the released sockets before Docker
  // publishes them; outbound ephemeral allocation cannot select this block.
  const migrations = migrationSources(path.join(root, 'apps/clued-cloud/supabase/migrations'));
  const marker = { schema: 'clued.g4.fresh-start/2', ...id, prepared: false, daemon_id: daemon,
    port_base: base, ports, port_policy: policy, source_config_sha256: hash(source), config_sha256: hash(config), migrations };
  // An attempt's prior marker is never silently reused, nor is any old volume deleted.
  fs.writeFileSync(markerPath(env), JSON.stringify(marker) + '\n', { flag: 'wx' });
  fs.writeFileSync(configAt(root), config);
  need(env.GITHUB_ENV, 'fresh_github_environment_required');
  fs.appendFileSync(env.GITHUB_ENV, `CLUED_G4_FRESH_PROJECT=${id.project}\nDOCKER_HOST=${SOCKET}\nDOCKER_CONTEXT=default\n`);
  marker.prepared = true;
  fs.writeFileSync(markerPath(env), JSON.stringify(marker) + '\n');
  return { project: id.project, fresh_inventory: true, migrations: migrations.length, port_base: base, ports };
}

export function verifyConfiguration(env, overrides) {
  const runtime = adapters(overrides);
  const { git, fs } = runtime;
  const daemon = requireLocal(env, runtime);
  const root = git('rev-parse', '--show-toplevel').trim();
  const marker = readMarker(env, fs);
  need(marker.daemon_id === daemon, 'fresh_docker_identity_changed');
  verifySourceState(marker, { head: git('rev-parse', 'HEAD').trim(),
    dirty: git('status', '--porcelain', '--untracked-files=no') });
  const source = git('show', `HEAD:${CONFIG}`);
  verifyPreparedConfiguration(source, fs.readFileSync(configAt(root), 'utf8'), env, marker);
  need(env.CLUED_G4_FRESH_PROJECT === marker.project, 'fresh_cleanup_target_missing');
  return { root, marker };
}

export function verify(env = process.env, overrides) {
  const runtime = adapters(overrides);
  const { docker } = runtime;
  const { root, marker } = verifyConfiguration(env, runtime);
  runtime.startLock(marker.daemon_id, env, runtime.fs);
  const ids = lines(docker('ps', '-q', '--no-trunc', '--filter', `label=${PROJECT_LABEL}=${marker.project}`));
  need(ids.length > 0 && ids.length <= 512 && ids.every(value => /^[0-9a-f]{64}$/.test(value)), 'fresh_started_inventory_unknown');
  const actualPorts = publishedPorts(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', ...ids));
  need([...actualPorts].every(port => Object.values(marker.ports).includes(port)), 'fresh_unmapped_host_port');
  const sources = migrationSources(path.join(root, 'apps/clued-cloud/supabase/migrations'));
  need(JSON.stringify(sources) === JSON.stringify(marker.migrations), 'fresh_migration_bytes_changed');
  const database = `supabase_db_${marker.project}`;
  const inspect = '{"name":{{json .Name}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"mounts":{{json .Mounts}}}';
  const container = JSON.parse(docker('inspect', '--format', inspect, database).trim());
  const labels = JSON.parse(docker('volume', 'inspect', '--format', '{{json .Labels}}', database).trim());
  verifyContainer(marker, container, labels);
  // Only now, with the configuration, the lock and the container proven to be this run's own, is the database
  // written: the whole chain, then the history it left is compared with the files below.
  runtime.applyMigrations(root);
  // Fixed local container and read-only query: never a linked/remote connection string.
  const sql = "select coalesce(json_agg(json_build_object('version',version,'name',name) order by version), '[]'::json) from supabase_migrations.schema_migrations";
  const history = JSON.parse(docker('exec', `supabase_db_${marker.project}`, 'psql', '-X', '-U', 'postgres',
    '-d', 'postgres', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql).trim());
  const result = verifyHistory(sources, history);
  return { ...result, project: marker.project, initialized_once: true, reset_skipped: true };
}

const PROJECT_LABEL = 'com.supabase.cli.project';
const ownName = (name, project) => /^supabase_[a-z0-9_]+_clued-g4-[0-9]+-[0-9]+$/.test(name) && name.endsWith(`_${project}`);
const INSPECT = {
  container: '{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"running":{{json .State.Running}}}',
  network: '{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Labels "com.supabase.cli.project")}}}',
  volume: '{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (index .Labels "com.supabase.cli.project")}}}',
};
function cleanupSnapshot(docker, project) {
  const groups = {};
  for (const kind of ['container', 'network', 'volume']) {
    const names = kind === 'container' ? '.Names' : '.Name';
    const id = kind === 'volume' ? '.Name' : '.ID';
    const format = `{"id":{{json ${id}}},"name":{{json ${names}}},"project":{{json (.Label "${PROJECT_LABEL}")}}}`;
    const args = kind === 'container' ? ['ps', '-a', '--no-trunc'] : [kind, 'ls', ...(kind === 'network' ? ['--no-trunc'] : [])];
    const rows = lines(docker(...args, '--format', format)).map(line => JSON.parse(line));
    need(rows.length <= 4096 && rows.every(row => row && typeof row.id === 'string' && typeof row.name === 'string' &&
      (row.project === null || typeof row.project === 'string')), 'fresh_cleanup_inventory_unknown');
    const selected = rows.filter(row => row.project === project || ownName(row.name, project));
    need(selected.every(row => row.project === project && ownName(row.name, project) &&
      (kind === 'volume' ? row.id === row.name : /^[0-9a-f]{64}$/.test(row.id))) &&
      new Set(selected.map(row => row.id)).size === selected.length, 'fresh_cleanup_identity');
    groups[kind] = selected;
  }
  return groups;
}
function inspectOwned(docker, kind, resource, project) {
  const args = kind === 'container' ? ['inspect'] : [kind, 'inspect'];
  const actual = JSON.parse(docker(...args, '--format', INSPECT[kind], resource.id).trim());
  need(actual.id === resource.id && actual.name.replace(/^\//, '') === resource.name && actual.project === project &&
    ownName(resource.name, project) && (kind !== 'container' || typeof actual.running === 'boolean'), 'fresh_cleanup_identity');
  return actual;
}
// Retain only fixed child-process metadata. Docker messages, stdout/stderr,
// arguments and arbitrary error properties may contain private material.
function safeChildFailure(error) {
  try {
    const ownValue = (input, key) => {
      if (!input || !['object', 'function'].includes(typeof input)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    };
    const input = ownValue(error, 'child_failure') ?? error;
    const status = ownValue(input, 'status'), signal = ownValue(input, 'signal'), code = ownValue(input, 'code');
    const detail = {};
    if (Number.isInteger(status) && status >= 0 && status <= 255) detail.status = status;
    if (['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT'].includes(signal)) detail.signal = signal;
    if (['ETIMEDOUT', 'ENOENT', 'EACCES', 'ECONNRESET', 'EPIPE', 'ENOBUFS',
      'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(code)) detail.code = code;
    return Object.keys(detail).length ? detail : undefined;
  } catch { return undefined; } // An accessor or Proxy cannot replace the fixed cleanup error.
}
const cleanupAction = (code, action) => {
  try { return action(); }
  catch (error) {
    const failure = new Error(/^fresh_[a-z_]+$/.test(error.message) ? error.message : code);
    failure.child_failure = safeChildFailure(error);
    throw failure;
  }
};

/** No Supabase global prune, forced removal, name glob deletion or foreign
 * stop. Unknown identity/exit leaves the remaining resources and diagnostics. */
export function cleanup(env = process.env, overrides) {
  const runtime = adapters(overrides), { docker, fs } = runtime;
  const { marker } = verifyConfiguration(env, runtime);
  try {
    const resources = cleanupAction('fresh_cleanup_inventory_unknown', () => cleanupSnapshot(docker, marker.project));
    // Prove all selected resource identities before the first mutation.
    for (const [kind, rows] of Object.entries(resources)) for (const row of rows)
      cleanupAction('fresh_cleanup_identity', () => inspectOwned(docker, kind, row, marker.project));
    for (const row of resources.container) {
      const current = cleanupAction('fresh_cleanup_identity', () => inspectOwned(docker, 'container', row, marker.project));
      if (current.running) cleanupAction('fresh_cleanup_container_stop_failed', () => docker('stop', '--time', '20', row.id));
      need(!cleanupAction('fresh_cleanup_identity', () => inspectOwned(docker, 'container', row, marker.project)).running,
        'fresh_cleanup_container_still_running');
      cleanupAction('fresh_cleanup_container_remove_failed', () => docker('rm', row.id));
    }
    for (const kind of ['network', 'volume']) for (const row of resources[kind]) {
      cleanupAction('fresh_cleanup_identity', () => inspectOwned(docker, kind, row, marker.project));
      cleanupAction(`fresh_cleanup_${kind}_remove_failed`, () => docker(kind, 'rm', row.id));
    }
    const remaining = cleanupAction('fresh_cleanup_inventory_unknown', () => cleanupSnapshot(docker, marker.project));
    need(Object.values(remaining).every(rows => rows.length === 0), 'fresh_cleanup_resources_remain');
    const result = { status: 'completed', project: marker.project,
      removed: Object.fromEntries(Object.entries(resources).map(([kind, rows]) => [kind, rows.length])) };
    fs.writeFileSync(markerPath(env), JSON.stringify({ ...marker, cleanup: result }) + '\n');
    return result;
  } catch (error) {
    const reason = /^fresh_[a-z_]+$/.test(error.message) ? error.message : 'fresh_cleanup_unavailable';
    const child = safeChildFailure(error);
    fs.writeFileSync(markerPath(env), JSON.stringify({ ...marker, cleanup: { status: 'failed', reason_code: reason,
      ...(child ? { child_failure: child } : {}) } }) + '\n');
    throw new Error(reason);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const result = mode === '--lock-path' ? startupLockPath(requireLocal(process.env, adapters())) :
    mode === '--prepare' ? await prepare() : mode === '--verify' ? verify() : mode === '--cleanup' ? cleanup() :
    mode === '--guard-cleanup' ? (verifyConfiguration(process.env), { cleanup_target_verified: true }) :
      (() => { throw new Error('fresh_unknown_mode'); })();
  console.log(mode === '--lock-path' ? result : JSON.stringify(result));
}
