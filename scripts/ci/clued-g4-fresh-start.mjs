import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

export function freshConfig(source, env) {
  const id = identity(env);
  need(source.split('project_id = "clued-cloud"').length === 2, 'fresh_project_source');
  const seed = /^\[db\.seed\][ \t]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(source)?.[1];
  need(seed && /^[ \t]*enabled[ \t]*=[ \t]*false[ \t]*$/m.test(seed), 'fresh_seed_must_be_disabled');
  // Consecutive attempts receive different project/volume identities and ports.
  const base = 45000 + ((id.run_id + id.run_attempt - 1) % 1000) * 10;
  let count = 0;
  const result = source.replace('project_id = "clued-cloud"', `project_id = "${id.project}"`)
    .replace(/^([ \t]*(?:port|shadow_port)[ \t]*=[ \t]*)5432([0-9])$/gm, (_, leading, digit) => {
      count++; return leading + (base + Number(digit));
    });
  need(count === 7, 'fresh_seven_ports');
  return result;
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
  const id = identity(env);
  const marker = JSON.parse(filesystem.readFileSync(markerPath(env), 'utf8'));
  need(marker.schema === 'clued.g4.fresh-start/1' && marker.prepared === true &&
    Object.entries(id).every(([key, value]) => marker[key] === value), 'fresh_marker_identity');
  return marker;
}
function configAt(root) { return path.join(root, CONFIG); }

function requireLocal(env, runtime) {
  need(runtime.platform === 'linux' && (!env.DOCKER_HOST || env.DOCKER_HOST === SOCKET) &&
    (!env.DOCKER_CONTEXT || env.DOCKER_CONTEXT === 'default'), 'fresh_local_docker_only');
  const endpoint = JSON.parse(runtime.docker('context', 'inspect', 'default', '--format', '{{json .Endpoints.docker.Host}}').trim());
  need(endpoint === SOCKET, 'fresh_default_context_not_local');
}

// Test-only command boundaries; the CLI always uses these fixed host defaults.
const adapters = (overrides = {}) => ({ git: defaultGit, docker: defaultDocker, fs,
  platform: process.platform, ...overrides });

export function prepare(env = process.env, overrides) {
  const runtime = adapters(overrides);
  const { git, docker, fs } = runtime;
  requireLocal(env, runtime);
  const id = identity(env);
  const root = git('rev-parse', '--show-toplevel').trim();
  need(git('rev-parse', 'HEAD').trim() === id.checkout_sha &&
    git('status', '--porcelain', '--untracked-files=no').trim() === '', 'fresh_clean_source_required');
  need(!fs.existsSync(path.join(root, 'apps/clued-cloud/supabase/.temp/project-ref')), 'fresh_linked_project_refused');
  const source = git('show', `HEAD:${CONFIG}`);
  need(fs.readFileSync(configAt(root), 'utf8') === source, 'fresh_config_source_changed');
  const config = freshConfig(source, env);
  const filter = `label=com.supabase.cli.project=${id.project}`;
  requireUnused({
    labelledContainers: lines(docker('ps', '-a', '--filter', filter, '--format', '{{.ID}}')),
    labelledVolumes: lines(docker('volume', 'ls', '--filter', filter, '--format', '{{.Name}}')),
    containerNames: lines(docker('ps', '-a', '--format', '{{.Names}}')),
    // The CLI checks its exact db volume even if an old one has lost its label.
    volumeNames: lines(docker('volume', 'ls', '--format', '{{.Name}}')),
  }, id.project);
  const migrations = migrationSources(path.join(root, 'apps/clued-cloud/supabase/migrations'));
  const marker = { schema: 'clued.g4.fresh-start/1', ...id, prepared: false,
    source_config_sha256: hash(source), config_sha256: hash(config), migrations };
  // An attempt's prior marker is never silently reused, nor is any old volume deleted.
  fs.writeFileSync(markerPath(env), JSON.stringify(marker) + '\n', { flag: 'wx' });
  fs.writeFileSync(configAt(root), config);
  need(env.GITHUB_ENV, 'fresh_github_environment_required');
  fs.appendFileSync(env.GITHUB_ENV, `CLUED_G4_FRESH_PROJECT=${id.project}\nDOCKER_HOST=${SOCKET}\nDOCKER_CONTEXT=default\n`);
  marker.prepared = true;
  fs.writeFileSync(markerPath(env), JSON.stringify(marker) + '\n');
  return { project: id.project, fresh_inventory: true, migrations: migrations.length };
}

export function verifyConfiguration(env, overrides) {
  const runtime = adapters(overrides);
  const { git, fs } = runtime;
  requireLocal(env, runtime);
  const root = git('rev-parse', '--show-toplevel').trim();
  const marker = readMarker(env, fs);
  verifySourceState(marker, { head: git('rev-parse', 'HEAD').trim(),
    dirty: git('status', '--porcelain', '--untracked-files=no') });
  const source = git('show', `HEAD:${CONFIG}`);
  need(marker.source_config_sha256 === hash(source) &&
    fs.readFileSync(configAt(root), 'utf8') === freshConfig(source, env) &&
    marker.config_sha256 === hash(fs.readFileSync(configAt(root))), 'fresh_configuration_changed');
  need(env.CLUED_G4_FRESH_PROJECT === marker.project, 'fresh_cleanup_target_missing');
  return { root, marker };
}

export function verify(env = process.env, overrides) {
  const runtime = adapters(overrides);
  const { docker } = runtime;
  const { root, marker } = verifyConfiguration(env, runtime);
  const sources = migrationSources(path.join(root, 'apps/clued-cloud/supabase/migrations'));
  need(JSON.stringify(sources) === JSON.stringify(marker.migrations), 'fresh_migration_bytes_changed');
  const database = `supabase_db_${marker.project}`;
  const inspect = '{"name":{{json .Name}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"mounts":{{json .Mounts}}}';
  const container = JSON.parse(docker('inspect', '--format', inspect, database).trim());
  const labels = JSON.parse(docker('volume', 'inspect', '--format', '{{json .Labels}}', database).trim());
  verifyContainer(marker, container, labels);
  // Fixed local container and read-only query: never a linked/remote connection string.
  const sql = "select coalesce(json_agg(json_build_object('version',version,'name',name) order by version), '[]'::json) from supabase_migrations.schema_migrations";
  const history = JSON.parse(docker('exec', `supabase_db_${marker.project}`, 'psql', '-X', '-U', 'postgres',
    '-d', 'postgres', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql).trim());
  const result = verifyHistory(sources, history);
  return { ...result, project: marker.project, initialized_once: true, reset_skipped: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const result = mode === '--prepare' ? prepare() : mode === '--verify' ? verify() :
    mode === '--guard-cleanup' ? (verifyConfiguration(process.env), { cleanup_target_verified: true }) :
      (() => { throw new Error('fresh_unknown_mode'); })();
  console.log(JSON.stringify(result));
}
