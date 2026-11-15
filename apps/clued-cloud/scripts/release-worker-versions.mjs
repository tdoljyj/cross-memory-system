// Automatic Worker rollback for the production release (PLAN 3a).
//
// record: right before the first deploy, read the version each production
//   Worker serves (wrangler deployments status --json). A Worker that does not
//   serve exactly one version at 100% stops the release before any deploy.
// rollback: after a failed deploy or post-deploy verification, roll back every
//   Worker whose served version is no longer the recorded one, last deployed
//   first, and read each one back. The database is forward-only and is never
//   touched here. The run still fails: a rollback restores service, it does not
//   make the release a success.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CONTRACT = 'clued.production-worker-versions.v1';
/** Deploy order of clued-cloud-production-release.yml; rollback runs in reverse. */
export const WORKERS = Object.freeze([
  Object.freeze({ name: 'clued-storage-pdf', config: 'wrangler.pdf-extractor.jsonc' }),
  Object.freeze({ name: 'clued-cloud', config: 'wrangler.production.jsonc' }),
  Object.freeze({ name: 'clued-connect', config: '../kooyumi-connect/wrangler.production.jsonc' }),
]);
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATTEMPTS = 3;

function npxWrangler(args) {
  const child = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
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
    const result = await wrangler(['deployments', 'status', '--name', name, '--json']);
    const version = result.status === 0 ? servedVersion(result.stdout) : null;
    if (version) return version;
    if (attempt < ATTEMPTS) await wait(5_000);
  }
  return null;
}

export async function recordVersions({ wrangler = npxWrangler, wait = pause, env = process.env } = {}) {
  const workers = [];
  for (const { name } of WORKERS) {
    const version_id = await readServed(wrangler, name, wait);
    if (!version_id) throw new Error(`${name} does not serve exactly one version at 100%; nothing was deployed`);
    workers.push({ name, version_id });
  }
  return { contract: CONTRACT, source_commit: env.GITHUB_SHA ?? null, recorded_at: new Date().toISOString(), workers };
}

export async function rollbackVersions({ recorded, wrangler = npxWrangler, wait = pause, env = process.env }) {
  if (recorded?.contract !== CONTRACT || !Array.isArray(recorded.workers) ||
      recorded.workers.map((w) => w?.name).join() !== WORKERS.map((w) => w.name).join() ||
      recorded.workers.some((w) => !VERSION_ID.test(w.version_id ?? ''))) {
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
    const result = await wrangler(['rollback', version_id, '--name', name, '--message', message, '--yes']);
    const after = await readServed(wrangler, name, wait);
    workers.push({ name, recorded: version_id, at_failure: before, served_after: after,
      action: after === version_id ? 'rolled_back' : 'rollback_failed',
      ...(result.status === 0 ? {} : { error: (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ') }) });
  }
  return { contract: 'clued.production-worker-rollback.v1', source_commit: env.GITHUB_SHA ?? null,
    ok: workers.every((w) => w.action !== 'rollback_failed'), finished_at: new Date().toISOString(), workers };
}

export function renderRollbackSummary(result) {
  const lines = ['## Automatic Worker rollback', '',
    'The release failed after the Workers were recorded. The database is forward-only and was not rolled back.', '',
    '| Worker | Recorded version | Served at failure | Result |', '| --- | --- | --- | --- |'];
  for (const w of result.workers) {
    lines.push(`| \`${w.name}\` | \`${w.recorded}\` | \`${w.at_failure ?? 'unreadable'}\` | ${w.action}${w.error ? `: ${w.error.replace(/\|/g, '/')}` : ''} |`);
  }
  lines.push('', result.ok ? 'Production serves the recorded versions again.'
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

export async function main(argv = process.argv.slice(2), { wrangler, wait, env = process.env } = {}) {
  const [command] = argv;
  const out = option(argv, '--out');
  if (command === 'record' && out) {
    const recorded = await recordVersions({ wrangler, wait, env });
    writeJson(out, recorded);
    console.log(recorded.workers.map((w) => `${w.name} serves ${w.version_id}`).join('\n'));
    return 0;
  }
  const from = option(argv, '--from');
  if (command === 'rollback' && from && out) {
    const result = await rollbackVersions({ recorded: JSON.parse(fs.readFileSync(from, 'utf8')), wrangler, wait, env });
    writeJson(out, result);
    const summary = renderRollbackSummary(result);
    console.log(summary);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    const rolledBack = result.workers.filter((w) => w.action === 'rolled_back').map((w) => w.name);
    console.error(`::error title=Release rolled back::${rolledBack.length ? `Rolled back ${rolledBack.join(', ')}` : 'No Worker had changed'}${result.ok ? '' : '; a rollback failed'}`);
    return result.ok ? 0 : 1;
  }
  console.error('usage: release-worker-versions.mjs record --out FILE | rollback --from FILE --out FILE');
  return 2;
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
