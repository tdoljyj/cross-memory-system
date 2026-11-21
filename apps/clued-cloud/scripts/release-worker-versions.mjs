// Automatic Worker rollback for the production release (PLAN 3a, Fable 1121 §6).
//
// record: before the grant and the first deploy, read the version each
//   production Worker serves (wrangler deployments status --json) and the
//   commit the public edge serves (main /healthz, Connect smoke). A Worker that
//   does not serve exactly one version at 100% stops the release before any
//   deploy. A release also stops unless the three wrangler production
//   configurations are byte for byte those of every commit the edge serves
//   (git diff): a version rollback undoes code, bindings and vars, not the
//   Worker's schedule, routes or queue wiring. deploy publishes such commits.
// rollback: after a failed deploy or post-deploy verification, roll back every
//   Worker whose served version is no longer the recorded one, last deployed
//   first, writing each Worker's result as soon as it is done. Then wait one
//   propagation window and read all three versions and both edge commits once:
//   only that reading decides "restored". The database is forward-only and is
//   never touched here. The run still fails: a rollback restores service, it
//   does not make the release a success.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as live from './currentness-live-build.mjs';
import { PUBLIC_ORIGIN } from '../../kooyumi-connect/verify-production.mjs';

export const CONTRACT = 'clued.production-worker-versions.v1';
/** Deploy order of clued-cloud-production-release.yml; rollback runs in reverse. */
export const WORKERS = Object.freeze([
  Object.freeze({ name: 'clued-storage-pdf' }),
  Object.freeze({ name: 'clued-cloud' }),
  Object.freeze({ name: 'clued-connect' }),
]);
/**
 * The wrangler production configurations a release must leave byte for byte
 * unchanged, in WORKERS order. In the release path a configuration path only
 * reaches readWranglerConfig or gitSameFiles (tests/production-release-gate.test.mjs).
 */
export const WRANGLER_CONFIGS = Object.freeze(['apps/clued-cloud/wrangler.pdf-extractor.jsonc',
  'apps/clued-cloud/wrangler.production.jsonc', 'apps/kooyumi-connect/wrangler.production.jsonc']);
const CONNECT_SMOKE_URL = `${PUBLIC_ORIGIN}/connect/api/smoke`;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
/** The two public edges a record names and the final reading compares. */
const EDGE_NAMES = Object.freeze(['clued-cloud', 'clued-connect']);
const ATTEMPTS = 3;
const RETRY_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EDGE_READ_TIMEOUT_MS = 20_000;
const APP = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = path.resolve(APP, '../..');

// Worst cases, for the workflow's step timeouts (tests check them).
const READ_SERVED_WORST_MS = ATTEMPTS * COMMAND_TIMEOUT_MS + (ATTEMPTS - 1) * RETRY_MS;
const EDGE_READ_WORST_MS = ATTEMPTS * EDGE_READ_TIMEOUT_MS + (ATTEMPTS - 1) * RETRY_MS;
export const RECORD_WORST_CASE_MS = WORKERS.length * READ_SERVED_WORST_MS + EDGE_READ_WORST_MS;
/** Every Worker failing every attempt, the propagation window, then the final reading. */
export const rollbackWorstCaseMs = (windowMs) => WORKERS.length * (READ_SERVED_WORST_MS +
  ATTEMPTS * (COMMAND_TIMEOUT_MS + READ_SERVED_WORST_MS) + (ATTEMPTS - 1) * RETRY_MS) + windowMs +
  WORKERS.length * READ_SERVED_WORST_MS + EDGE_READ_TIMEOUT_MS;

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
      edge = Object.fromEntries(EDGE_NAMES.map((name) => [name, { error: error?.message ?? String(error) }]));
    }
    if (Object.values(edge).every((value) => SHA.test(value?.source_commit ?? ''))) return edge;
    if (attempt < ATTEMPTS) await wait(RETRY_MS);
  }
  return edge;
}

/** `git diff --quiet <commit> HEAD -- <files>`: true when identical, false when not; throws when git cannot tell. */
export function gitDiffQuiet(commit, files) {
  if (!SHA.test(commit ?? '')) throw new Error(`not a commit: ${commit}`);
  const run = spawnSync('git', ['diff', '--quiet', commit, 'HEAD', '--', ...files], { cwd: REPOSITORY, encoding: 'utf8' });
  if (run.error || (run.status !== 0 && run.status !== 1)) throw new Error(`git cannot compare with ${commit}`);
  return run.status === 0;
}

export async function recordVersions({ wrangler = npxWrangler, wait = pause, env = process.env, mode,
  readEdges = readEdgeCommits, gitSameFiles = gitDiffQuiet } = {}) {
  if (mode !== 'deploy' && mode !== 'release') throw new Error(`record needs --mode deploy or release, not ${mode}`);
  const workers = [];
  for (const { name } of WORKERS) {
    const version_id = await readServed(wrangler, name, wait);
    if (!version_id) throw new Error(`${name} does not serve exactly one version at 100%; nothing was deployed`);
    workers.push({ name, version_id });
  }
  const edge = await readEdgesWithRetry(readEdges, wait);
  const unreadable = Object.entries(edge).filter(([, value]) => !SHA.test(value?.source_commit ?? ''));
  let config_identical = null;
  let configError;
  if (!unreadable.length) {
    try {
      config_identical = true;
      for (const commit of new Set(Object.values(edge).map((value) => value.source_commit))) {
        if (!(await gitSameFiles(commit, WRANGLER_CONFIGS))) config_identical = false;
      }
    } catch (error) {
      config_identical = null;
      configError = error?.message ?? String(error);
    }
  }
  if (mode === 'release') {
    if (unreadable.length) {
      throw new Error(`a release compares its wrangler configuration with the commit the edge serves, and ${unreadable.map(([name, value]) =>
        `${name} is unreadable (${value?.error ?? 'no commit'})`).join(', ')}; nothing was deployed`);
    }
    if (config_identical !== true) {
      throw new Error(`${configError ? `${configError}; ` : ''}the three wrangler production configurations are not byte for byte the ones the edge serves; a Worker rollback would not undo it; publish this commit with deploy mode; nothing was deployed`);
    }
  }
  return { contract: CONTRACT, mode, source_commit: env.GITHUB_SHA ?? null, recorded_at: new Date().toISOString(),
    workers, edge, config_identical };
}

const edgeMatches = (recorded, served) => SHA.test(recorded?.source_commit ?? '') &&
  served?.source_commit === recorded.source_commit && (recorded.revision === undefined || served?.revision === recorded.revision);

export async function rollbackVersions({ recorded, wrangler = npxWrangler, wait = pause, env = process.env,
  readEdges = readEdgeCommits, windowMs, sleep = pause, onProgress = () => {} }) {
  if (recorded?.contract !== CONTRACT || !Array.isArray(recorded.workers) ||
      recorded.workers.map((w) => w?.name).join() !== WORKERS.map((w) => w.name).join() ||
      recorded.workers.some((w) => !VERSION_ID.test(w.version_id ?? '')) ||
      !recorded.edge || typeof recorded.edge !== 'object' ||
      // "restored" compares both public edges; a record without both cannot say it.
      EDGE_NAMES.some((name) => !recorded.edge[name] || typeof recorded.edge[name] !== 'object')) {
    throw Object.assign(new Error('recorded Worker versions are not a valid record of this release'), { invalidRecord: true });
  }
  const message = `Automatic rollback: release ${env.GITHUB_SHA ?? '?'} failed (run ${env.GITHUB_RUN_ID ?? '?'})`;
  const base = { contract: 'clued.production-worker-rollback.v1', source_commit: env.GITHUB_SHA ?? null };
  const workers = [];
  for (const { name, version_id } of [...recorded.workers].reverse()) {
    const before = await readServed(wrangler, name, wait);
    if (before === version_id) {
      workers.push({ name, recorded: version_id, at_failure: before, action: 'unchanged' });
    } else {
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
    // On disk at once: a step killed half way still shows what it did.
    onProgress({ ...base, ok: false, status: 'in_progress', workers: [...workers] });
  }
  // One reading, a whole propagation window after the last action: a late
  // deploy or an edge still moving shows up here, not as an early match.
  const mismatches = [];
  try {
    await sleep(windowMs ?? propagationWindowMs());
  } catch (error) {
    mismatches.push(`no propagation window: ${error?.message ?? error}`);
  }
  const versions = [];
  for (const { name, version_id } of recorded.workers) {
    const served = await readServed(wrangler, name, wait);
    versions.push({ name, recorded: version_id, served, matches: served === version_id });
    if (served !== version_id) mismatches.push(`${name} serves ${served ?? 'an unreadable version'}, recorded ${version_id}`);
  }
  let servedEdge;
  try { servedEdge = await readEdges(); } catch (error) { servedEdge = { error: error?.message ?? String(error) }; }
  const edge = EDGE_NAMES.map((name) => {
    const matches = edgeMatches(recorded.edge[name], servedEdge?.[name]);
    if (!matches) {
      mismatches.push(`edge ${name} serves ${servedEdge?.[name]?.source_commit ?? 'an unreadable commit'}, recorded ${recorded.edge[name]?.source_commit ?? 'unreadable'}`);
    }
    return { name, recorded: recorded.edge[name], served: servedEdge?.[name] ?? null, matches };
  });
  const status = mismatches.length ? 'not_restored' : 'restored';
  return { ...base, ok: status === 'restored', status, finished_at: new Date().toISOString(), workers,
    final_reading: { versions, edge }, mismatches };
}

export function renderRollbackSummary(result) {
  const lines = ['## Automatic Worker rollback', '',
    'The release failed after the Workers were recorded. The database is forward-only and was not rolled back.', '',
    '| Worker | Recorded version | Served at failure | Result |', '| --- | --- | --- | --- |'];
  for (const w of result.workers) {
    lines.push(`| \`${w.name}\` | \`${w.recorded}\` | \`${w.at_failure ?? 'unreadable'}\` | ${w.action}${w.error ? `: ${w.error.replace(/\|/g, '/')}` : ''} |`);
  }
  const commit = (value) => (value?.source_commit ? `\`${value.source_commit.slice(0, 12)}\`${value.revision ? ` ${value.revision}` : ''}` : `unreadable${value?.error ? `: ${String(value.error).replace(/\|/g, '/')}` : ''}`);
  lines.push('', 'Final reading, one propagation window after the rollback:', '',
    '| Item | Recorded | Served | Matches |', '| --- | --- | --- | --- |');
  for (const v of result.final_reading?.versions ?? []) lines.push(`| \`${v.name}\` version | \`${v.recorded}\` | \`${v.served ?? 'unreadable'}\` | ${v.matches ? 'yes' : 'no'} |`);
  for (const e of result.final_reading?.edge ?? []) lines.push(`| \`${e.name}\` edge | ${commit(e.recorded)} | ${commit(e.served)} | ${e.matches ? 'yes' : 'no'} |`);
  lines.push('', result.status === 'restored'
    ? 'Production serves the recorded versions again, and the edge serves the recorded commits.'
    : `**Not restored: ${result.mismatches.join('; ').replace(/\|/g, '/')}. Check production before releasing again.**`,
  '', 'Worker settings changed by hand outside the repository are not restored by a rollback: the release applied the repository\'s configuration.', '');
  return lines.join('\n');
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

// Write to a temporary file and rename it over the old one: a kill during the
// write leaves the previous complete file in place.
function writeJson(file, value, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fileSystem.renameSync(temporary, file);
}

export async function main(argv = process.argv.slice(2), { wrangler, wait, env = process.env, readEdges, gitSameFiles, windowMs, sleep,
  fileSystem = fs } = {}) {
  const [command] = argv;
  const out = option(argv, '--out');
  const mode = option(argv, '--mode');
  if (command === 'record' && out && (mode === 'deploy' || mode === 'release')) {
    const recorded = await recordVersions({ wrangler, wait, env, mode, readEdges, gitSameFiles });
    writeJson(out, recorded, fileSystem);
    console.log(recorded.workers.map((w) => `${w.name} serves ${w.version_id}`).join('\n'));
    for (const [name, value] of Object.entries(recorded.edge)) console.log(`edge ${name}: ${value.source_commit ?? `unreadable (${value.error})`}`);
    if (recorded.config_identical === false) {
      console.error('::warning::the wrangler production configuration differs from the commit the edge serves; a rollback of this run would not undo that part');
    }
    return 0;
  }
  const from = option(argv, '--from');
  if (command === 'rollback' && from && out) {
    let result;
    try {
      let recorded;
      try {
        recorded = JSON.parse(fs.readFileSync(from, 'utf8'));
      } catch (error) {
        throw Object.assign(new Error(`recorded Worker versions are not a valid record of this release: ${error?.message ?? error}`),
          { invalidRecord: true });
      }
      result = await rollbackVersions({ recorded, wrangler, wait, env, readEdges, windowMs, sleep,
        onProgress: (partial) => writeJson(out, partial, fileSystem) });
    } catch (error) {
      if (!error?.invalidRecord) throw error;
      // Nothing was rolled back, and nothing can be shown restored: say so on disk.
      const refused = { contract: 'clued.production-worker-rollback.v1', source_commit: env.GITHUB_SHA ?? null, ok: false,
        status: 'not_restored', reason: error.message, finished_at: new Date().toISOString(), workers: [], mismatches: [error.message] };
      writeJson(out, refused, fileSystem);
      const line = `## Automatic Worker rollback\n\n**Not restored: ${error.message}. Nothing was rolled back; check production before releasing again.**\n`;
      console.log(line);
      if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, line);
      console.error(`::error title=Release not rolled back::not restored: ${error.message}`);
      return 1;
    }
    writeJson(out, result, fileSystem);
    const summary = renderRollbackSummary(result);
    console.log(summary);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    const rolledBack = result.workers.filter((w) => w.action === 'rolled_back').map((w) => w.name);
    console.error(`::error title=Release rolled back::${rolledBack.length ? `Rolled back ${rolledBack.join(', ')}` : 'No Worker had changed'}${
      result.status === 'restored' ? '' : `; not restored: ${result.mismatches.join('; ')}`}`);
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
