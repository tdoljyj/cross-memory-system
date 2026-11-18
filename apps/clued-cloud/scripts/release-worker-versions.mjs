// Automatic Worker rollback for the production release (PLAN 3a, Fable 1121).
//
// record: before the grant and the first deploy, read the version each
//   production Worker serves (wrangler deployments status --json) and the
//   commit the public edge serves (main /healthz, Connect smoke). A Worker that
//   does not serve exactly one version at 100% stops the release before any
//   deploy. In release mode it also stops when this commit changes a Worker
//   setting that a version rollback does not undo (UNVERSIONED_KEYS), compared
//   by git against the commit the edge serves; deploy publishes those.
// rollback: after a failed deploy or post-deploy verification, roll back every
//   Worker whose served version is no longer the recorded one, last deployed
//   first, and read each one back; then wait, within the release's propagation
//   window, for the edge to serve the recorded commits again. Only both make
//   "restored". The database is forward-only and is never touched here. The
//   run still fails: a rollback restores service, it does not make the release
//   a success.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as live from './currentness-live-build.mjs';
import { PUBLIC_ORIGIN } from '../../kooyumi-connect/verify-production.mjs';

export const CONTRACT = 'clued.production-worker-versions.v1';
/** Deploy order of clued-cloud-production-release.yml; rollback runs in reverse. */
export const WORKERS = Object.freeze([
  Object.freeze({ name: 'clued-storage-pdf', config: 'wrangler.pdf-extractor.jsonc' }),
  Object.freeze({ name: 'clued-cloud', config: 'wrangler.production.jsonc' }),
  Object.freeze({ name: 'clued-connect', config: '../kooyumi-connect/wrangler.production.jsonc' }),
]);
/**
 * Worker settings a version rollback does not undo. `wrangler rollback`
 * restores a version (code, bindings, vars); triggers, routes, queue consumers
 * and Durable Object migrations stay as the failed deploy left them.
 */
export const UNVERSIONED_KEYS = Object.freeze(['triggers', 'routes', 'queues.consumers', 'migrations']);
/**
 * Which edge commit each Worker's configuration is compared against. The PDF
 * extractor has no public entry; it ships in step with the main Worker.
 */
const EDGE_OF = Object.freeze({ 'clued-storage-pdf': 'clued-cloud', 'clued-cloud': 'clued-cloud', 'clued-connect': 'clued-connect' });
const CONNECT_SMOKE_URL = `${PUBLIC_ORIGIN}/connect/api/smoke`;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const ATTEMPTS = 3;
const RETRY_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EDGE_READ_TIMEOUT_MS = 20_000;
const EDGE_POLL_MS = 10_000;
const APP = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = path.resolve(APP, '../..');

// Worst cases, for the workflow's step timeouts (tests check them).
const READ_SERVED_WORST_MS = ATTEMPTS * COMMAND_TIMEOUT_MS + (ATTEMPTS - 1) * RETRY_MS;
const EDGE_READ_WORST_MS = ATTEMPTS * EDGE_READ_TIMEOUT_MS + (ATTEMPTS - 1) * RETRY_MS;
export const RECORD_WORST_CASE_MS = WORKERS.length * READ_SERVED_WORST_MS + EDGE_READ_WORST_MS;
/** Every Worker failing every attempt, then the whole edge window and one more read. */
export const rollbackWorstCaseMs = (windowMs) => WORKERS.length * (READ_SERVED_WORST_MS +
  ATTEMPTS * (COMMAND_TIMEOUT_MS + READ_SERVED_WORST_MS) + (ATTEMPTS - 1) * RETRY_MS) + windowMs + EDGE_READ_TIMEOUT_MS;

/**
 * The window in which Cloudflare's edge reaches a new or restored version:
 * the one the release verification waits in (currentness-live-build.mjs,
 * Task df6dc467). Without it the edge cannot be confirmed.
 */
export function propagationWindowMs(source = live) {
  const ms = source.PROPAGATION_WINDOW_MS;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error('currentness-live-build.mjs exports no PROPAGATION_WINDOW_MS (Task df6dc467)');
  }
  return ms;
}

export function npxWrangler(args, { spawn = spawnSync } = {}) {
  // Use the lockfile-installed CLI directly: no network installation on the
  // recovery path, and no Windows .cmd shim. Bound every invocation so one
  // stalled command cannot consume the job's entire recovery window.
  const cli = fileURLToPath(new URL('../node_modules/wrangler/wrangler-dist/cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
  });
  return { status: child.status ?? 1, stdout: child.stdout ?? '',
    stderr: [child.stderr, child.error?.message].filter(Boolean).join('\n') };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The single version a deployment serves at 100%, or null. */
export function servedVersion(stdout) {
  const text = String(stdout ?? '');
  let deployment;
  try { deployment = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return null; }
  const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
  if (versions.length !== 1 || versions[0]?.percentage !== 100) return null;
  return VERSION_ID.test(versions[0]?.version_id ?? '') ? versions[0].version_id : null;
}

async function readServed(wrangler, name, wait) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const result = await invoke(wrangler, ['deployments', 'status', '--name', name, '--json']);
    const version = result.status === 0 ? servedVersion(result.stdout) : null;
    if (version) return version;
    if (attempt < ATTEMPTS) await wait(RETRY_MS);
  }
  return null;
}

// A process launch failure is a failed command, not a reason to abandon the
// remaining Workers. Recording still fails closed when no version is readable.
async function invoke(wrangler, args) {
  try { return await wrangler(args); } catch (error) {
    return { status: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(`${url}?probe=${Date.now()}`, { method: 'GET', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(EDGE_READ_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** The commit the public edge serves for each Worker with a public entry; an { error } where it is unreadable. */
export async function readEdgeCommits({ fetchImpl = globalThis.fetch } = {}) {
  const read = async (fn) => { try { return await fn(); } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } };
  const [main, connect] = await Promise.all([
    read(async () => {
      const body = await getJson(fetchImpl, live.PRODUCTION_HEALTH_URL);
      if (body?.status !== 'ok' || body?.service !== 'clued-continuity' || !SHA.test(body?.source_commit ?? '')) {
        throw new Error('health endpoint names no trustworthy source commit');
      }
      return { source_commit: body.source_commit };
    }),
    read(async () => {
      const body = await getJson(fetchImpl, CONNECT_SMOKE_URL);
      if (body?.connect_service !== 'clued-connect' || !SHA.test(body?.source_commit ?? '') ||
          typeof body?.revision !== 'string' || !body.revision) {
        throw new Error('Connect smoke names no trustworthy source commit and revision');
      }
      return { source_commit: body.source_commit, revision: body.revision };
    }),
  ]);
  return { 'clued-cloud': main, 'clued-connect': connect };
}

async function readEdgesWithRetry(readEdges, wait) {
  let edge;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try { edge = await readEdges(); } catch (error) {
      edge = Object.fromEntries(Object.values(EDGE_OF).map((name) => [name, { error: error?.message ?? String(error) }]));
    }
    if (Object.values(edge).every((value) => SHA.test(value?.source_commit ?? ''))) return edge;
    if (attempt < ATTEMPTS) await wait(RETRY_MS);
  }
  return edge;
}

export function gitShowFile(commit, file) {
  const run = spawnSync('git', ['show', `${commit}:${file}`], { cwd: REPOSITORY, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new Error(`git cannot show ${file} at ${commit}`);
  return run.stdout;
}

const repositoryPath = (config) => path.posix.normalize(`apps/clued-cloud/${config}`);
const pick = (value, key) => key.split('.').reduce((at, part) => (at == null ? undefined : at[part]), value);
const canonical = (value) => JSON.stringify(value === undefined ? null : value);

/** Settings a version rollback does not undo that differ between the commit the edge serves and HEAD. */
export async function unversionedConfigChanges({ edge, gitShow }) {
  const changes = [];
  for (const { name, config } of WORKERS) {
    const from = edge?.[EDGE_OF[name]]?.source_commit;
    const file = repositoryPath(config);
    const parse = async (commit) => {
      try { return JSON.parse(await gitShow(commit, file)); } catch (error) {
        throw new Error(`cannot read ${file} at ${commit}: ${error?.message ?? error}`);
      }
    };
    const [before, after] = [await parse(from), await parse('HEAD')];
    for (const key of UNVERSIONED_KEYS) {
      if (canonical(pick(before, key)) !== canonical(pick(after, key))) changes.push({ worker: name, file, key, from });
    }
  }
  return changes;
}

export async function recordVersions({ wrangler = npxWrangler, wait = pause, env = process.env, mode,
  readEdges = readEdgeCommits, gitShow = gitShowFile } = {}) {
  if (mode !== 'deploy' && mode !== 'release') throw new Error(`record needs --mode deploy or release, not ${mode}`);
  const workers = [];
  for (const { name } of WORKERS) {
    const version_id = await readServed(wrangler, name, wait);
    if (!version_id) throw new Error(`${name} does not serve exactly one version at 100%; nothing was deployed`);
    workers.push({ name, version_id });
  }
  const edge = await readEdgesWithRetry(readEdges, wait);
  const unreadable = Object.entries(edge).filter(([, value]) => !SHA.test(value?.source_commit ?? ''));
  let unversioned_changes = null;
  if (!unreadable.length) {
    try {
      unversioned_changes = await unversionedConfigChanges({ edge, gitShow });
    } catch (error) {
      if (mode === 'release') throw new Error(`${error.message}; a release cannot prove its settings roll back; nothing was deployed`);
    }
  }
  if (mode === 'release') {
    if (unreadable.length) {
      throw new Error(`a release compares its settings with the commit the edge serves, and ${unreadable.map(([name, value]) =>
        `${name} is unreadable (${value?.error ?? 'no commit'})`).join(', ')}; nothing was deployed`);
    }
    if (unversioned_changes.length) {
      throw new Error(`a Worker version rollback cannot undo ${unversioned_changes.map((c) =>
        `${c.worker} ${c.key} (${c.file}, changed since ${c.from.slice(0, 12)})`).join('; ')}; publish this commit with deploy mode; nothing was deployed`);
    }
  }
  return { contract: CONTRACT, mode, source_commit: env.GITHUB_SHA ?? null, recorded_at: new Date().toISOString(),
    workers, edge, unversioned_changes };
}

const edgeMatches = (recorded, served) => SHA.test(recorded?.source_commit ?? '') &&
  served?.source_commit === recorded.source_commit && (recorded.revision === undefined || served?.revision === recorded.revision);

async function confirmEdge({ recorded, readEdges, windowMs, now, sleep }) {
  const names = Object.keys(recorded ?? {});
  const deadline = now() + windowMs;
  let served = {};
  for (;;) {
    try { served = await readEdges(); } catch (error) { served = { error: error?.message ?? String(error) }; }
    if (names.every((name) => edgeMatches(recorded[name], served?.[name]))) break;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(EDGE_POLL_MS, remaining));
  }
  return names.map((name) => ({ name, recorded: recorded[name], served: served?.[name] ?? null,
    confirmed: edgeMatches(recorded[name], served?.[name]) }));
}

export async function rollbackVersions({ recorded, wrangler = npxWrangler, wait = pause, env = process.env,
  readEdges = readEdgeCommits, windowMs, now = Date.now, sleep = pause }) {
  if (recorded?.contract !== CONTRACT || !Array.isArray(recorded.workers) ||
      recorded.workers.map((w) => w?.name).join() !== WORKERS.map((w) => w.name).join() ||
      recorded.workers.some((w) => !VERSION_ID.test(w.version_id ?? '')) ||
      !recorded.edge || typeof recorded.edge !== 'object') {
    throw new Error('recorded Worker versions are not a valid record of this release');
  }
  const message = `Automatic rollback: release ${env.GITHUB_SHA ?? '?'} failed (run ${env.GITHUB_RUN_ID ?? '?'})`;
  const workers = [];
  for (const { name, version_id } of [...recorded.workers].reverse()) {
    const before = await readServed(wrangler, name, wait);
    if (before === version_id) {
      workers.push({ name, recorded: version_id, at_failure: before, action: 'unchanged' });
      continue;
    }
    let result; let after;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      result = await invoke(wrangler, ['rollback', version_id, '--name', name, '--message', message, '--yes']);
      // A timed-out response may still have changed production. Read back
      // before retrying, and use the served version as the success criterion.
      after = await readServed(wrangler, name, wait);
      if (after === version_id) break;
      if (attempt < ATTEMPTS) await wait(RETRY_MS);
    }
    workers.push({ name, recorded: version_id, at_failure: before, served_after: after,
      action: after === version_id ? 'rolled_back' : 'rollback_failed',
      ...(result.status === 0 ? {} : { error: (result.stderr || result.stdout || 'Wrangler failed').trim().split('\n').slice(-3).join(' ') }) });
  }
  const versionsRestored = workers.every((w) => w.action !== 'rollback_failed');
  let edge = Object.keys(recorded.edge).map((name) => ({ name, recorded: recorded.edge[name], served: null, confirmed: false }));
  let edgeError;
  if (versionsRestored) {
    try {
      edge = await confirmEdge({ recorded: recorded.edge, readEdges, windowMs: windowMs ?? propagationWindowMs(), now, sleep });
    } catch (error) {
      edgeError = error?.message ?? String(error);
    }
  }
  const status = !versionsRestored ? 'rollback_failed'
    : edge.every((e) => e.confirmed) ? 'restored' : 'versions_restored_edge_unconfirmed';
  return { contract: 'clued.production-worker-rollback.v1', source_commit: env.GITHUB_SHA ?? null,
    ok: status === 'restored', status, finished_at: new Date().toISOString(), workers, edge,
    ...(edgeError ? { edge_error: edgeError } : {}) };
}

export function renderRollbackSummary(result) {
  const lines = ['## Automatic Worker rollback', '',
    'The release failed after the Workers were recorded. The database is forward-only and was not rolled back.', '',
    '| Worker | Recorded version | Served at failure | Result |', '| --- | --- | --- | --- |'];
  for (const w of result.workers) {
    lines.push(`| \`${w.name}\` | \`${w.recorded}\` | \`${w.at_failure ?? 'unreadable'}\` | ${w.action}${w.error ? `: ${w.error.replace(/\|/g, '/')}` : ''} |`);
  }
  const commit = (value) => (value?.source_commit ? `\`${value.source_commit.slice(0, 12)}\`${value.revision ? ` ${value.revision}` : ''}` : `unreadable${value?.error ? `: ${String(value.error).replace(/\|/g, '/')}` : ''}`);
  lines.push('', '| Edge | Recorded commit | Served after rollback | Confirmed |', '| --- | --- | --- | --- |');
  for (const e of result.edge ?? []) lines.push(`| \`${e.name}\` | ${commit(e.recorded)} | ${commit(e.served)} | ${e.confirmed ? 'yes' : 'no'} |`);
  lines.push('', result.status === 'restored' ? 'Production serves the recorded versions again, and the edge serves the recorded commits.'
    : result.status === 'versions_restored_edge_unconfirmed'
      ? `**The recorded versions are back at 100%, but the edge was not confirmed to serve the recorded commits${result.edge_error ? ` (${result.edge_error})` : ''}. Check production before releasing again.**`
      : '**A Worker could not be rolled back; production may still serve the failed release.**', '');
  return lines.join('\n');
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2), { wrangler, wait, env = process.env, readEdges, gitShow, windowMs, now, sleep } = {}) {
  const [command] = argv;
  const out = option(argv, '--out');
  const mode = option(argv, '--mode');
  if (command === 'record' && out && (mode === 'deploy' || mode === 'release')) {
    const recorded = await recordVersions({ wrangler, wait, env, mode, readEdges, gitShow });
    writeJson(out, recorded);
    console.log(recorded.workers.map((w) => `${w.name} serves ${w.version_id}`).join('\n'));
    for (const [name, value] of Object.entries(recorded.edge)) console.log(`edge ${name}: ${value.source_commit ?? `unreadable (${value.error})`}`);
    for (const change of recorded.unversioned_changes ?? []) {
      console.error(`::warning::deploy changes ${change.worker} ${change.key}; a rollback of this run would not undo it`);
    }
    return 0;
  }
  const from = option(argv, '--from');
  if (command === 'rollback' && from && out) {
    const result = await rollbackVersions({ recorded: JSON.parse(fs.readFileSync(from, 'utf8')), wrangler, wait, env, readEdges, windowMs, now, sleep });
    writeJson(out, result);
    const summary = renderRollbackSummary(result);
    console.log(summary);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    const rolledBack = result.workers.filter((w) => w.action === 'rolled_back').map((w) => w.name);
    console.error(`::error title=Release rolled back::${rolledBack.length ? `Rolled back ${rolledBack.join(', ')}` : 'No Worker had changed'}${
      result.status === 'rollback_failed' ? '; a rollback failed' : result.status === 'restored' ? '' : '; the edge was not confirmed'}`);
    return result.ok ? 0 : 1;
  }
  console.error('usage: release-worker-versions.mjs record --mode deploy|release --out FILE | rollback --from FILE --out FILE');
  return 2;
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
