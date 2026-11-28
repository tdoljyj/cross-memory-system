import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ensureDir, readJson, writeNew } from '../../src/store.mjs';
import { admitFleetRelease, insist, RELEASE_OWNER } from './release-admission.mjs';
import { missingMigrations, releaseRequirements, requirementsDigest, SNAPSHOT_LABEL } from './release-migrations.mjs';

const workflow = 'clued-cloud-production-release.yml';
const workflowPath = `.github/workflows/${workflow}`;
const runKey = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const runTitle = (mode, key) => `fleet-release-${mode}-${key}`;
const validId = id => Number.isSafeInteger(id) && id > 0;
const pollMs = 5_000;
const readinessMs = 60_000;

export async function reconcileFleetRelease(release) {
  await release.admit();
  const requirements = await release.requirements();
  const first = await release.read(requirements);
  const missing = missingMigrations(requirements, first.snapshot);
  let migrationRunId = null;
  if (missing.length) {
    await release.admit();
    const applied = await release.migrate(missing, requirements);
    const remaining = missingMigrations(requirements, applied.snapshot);
    insist(remaining.length === 0, 'FLEET_MIGRATION_INCOMPLETE', { missing: remaining });
    migrationRunId = applied.runId;
  }
  await release.admit();
  return { requirementsSha256: requirementsDigest(requirements), readRunId: first.runId, migrationRunId, dispatched: missing };
}

export function fleetReleaseWorkflow({ repository, commit, runGh, pause = sleep, keyOf = randomUUID,
  requirements = releaseRequirements, publisherStateDirectory = path.join(homedir(), '.clued-fleet-publisher', 'migration-attempts') }) {
  const base = `repos/${repository}/actions`;
  const dispatchPath = `${base}/workflows/${workflow}/dispatches`;
  const subject = { repository, commit };
  let attempt;
  const call = (args, code = 'FLEET_RELEASE_GITHUB_UNREADABLE') => {
    let result;
    try { result = runGh(args, 30_000); } catch { insist(false, code); }
    insist(result?.status === 0, code);
    return result.stdout;
  };
  const json = (args, code) => {
    const raw = call(args, code);
    try { return JSON.parse(raw); } catch { insist(false, code ?? 'FLEET_RELEASE_GITHUB_UNREADABLE'); }
  };
  const api = endpoint => json(['api', endpoint, '--hostname', 'github.com']);
  const dispatch = (mode, key, missing = []) => {
    const inputs = { mode, expected_release_sha: commit, fleet_release_run: key, ...(missing.length && { migrations: missing.join(',') }) };
    const result = json(['api', '--method', 'POST', '-H', 'X-GitHub-Api-Version: 2026-03-10', dispatchPath, '--hostname', 'github.com', '-f', 'ref=main',
      ...Object.entries(inputs).flatMap(([name, value]) => ['-f', `inputs[${name}]=${value}`])], 'FLEET_MIGRATION_DISPATCH_UNKNOWN');
    insist(validId(result?.workflow_run_id), 'FLEET_MIGRATION_DISPATCH_UNKNOWN', { key });
    return result.workflow_run_id;
  };
  const bound = (run, id, mode, key) => insist(run?.id === id && run.path === workflowPath && run.display_title === runTitle(mode, key) &&
    run.event === 'workflow_dispatch' && run.run_attempt === 1 && run.head_branch === 'main' && run.head_sha === commit &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.actor?.login === RELEASE_OWNER && run.triggering_actor?.login === RELEASE_OWNER, 'FLEET_MIGRATION_RUN_SUBJECT_CHANGED', { id });
  const wait = async (id, mode, key, { newlyDispatched = false } = {}) => {
    const deadline = AbortSignal.timeout(50 * 60_000);
    let readyBy = newlyDispatched ? performance.now() + readinessMs : null;
    for (let i = 0; i < 600 && !deadline.aborted; i++) {
      let delay = pollMs;
      try {
        const run = api(`${base}/runs/${id}`);
        bound(run, id, mode, key);
        readyBy = null;
        if (run.status === 'completed') return run;
      } catch (error) {
        const unreadable = error.code === 'FLEET_RELEASE_GITHUB_UNREADABLE';
        if (readyBy === null || (!unreadable && error.code !== 'FLEET_MIGRATION_RUN_SUBJECT_CHANGED')) throw error;
        const remaining = readyBy - performance.now();
        if (remaining <= 0 || i >= readinessMs / pollMs) {
          if (!unreadable) throw error;
          insist(false, 'FLEET_MIGRATION_RUN_UNRESOLVED', { id, key });
        }
        delay = Math.min(pollMs, remaining);
      }
      await pause(delay);
    }
    insist(false, 'FLEET_MIGRATION_RUN_UNRESOLVED', { id, key });
  };
  const readResult = async (mode, id, key, plan) => {
    const run = await wait(id, mode, key, { newlyDispatched: true });
    insist(run.conclusion === 'success', 'FLEET_MIGRATION_RUN_FAILED', { id, mode, conclusion: run.conclusion });
    const log = call(['run', 'view', String(id), '--repo', `github.com/${repository}`, '--attempt', '1', '--log']);
    const lines = log.split(/\r?\n/).filter(line => line.includes(`${SNAPSHOT_LABEL} `));
    insist(lines.length === 1, 'FLEET_MIGRATION_READBACK_REFUSED', { id });
    let result;
    try { result = JSON.parse(lines[0].split(`${SNAPSHOT_LABEL} `)[1]); } catch { insist(false, 'FLEET_MIGRATION_READBACK_REFUSED', { id }); }
    insist(result?.commit === commit && result.runId === String(id) && result.requirementsSha256 === requirementsDigest(plan),
      'FLEET_MIGRATION_READBACK_REFUSED', { id });
    return { runId: result.runId, snapshot: result.snapshot };
  };

  const code = 'FLEET_MIGRATION_JOURNAL_REFUSED';
  const persist = async (file, value) => {
    try { await writeNew(file, value); } catch (error) { insist(false, code, error.code); }
  };
  const readRecord = async file => {
    try { return (await readJson(file)).value; }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      insist(false, code, error.code);
    }
  };
  const readPriorAttempt = async plan => {
    const digest = requirementsDigest(plan);
    const directory = path.join(publisherStateDirectory, ...repository.split('/'), commit, digest);
    await ensureDir(directory);
    const slots = (await fs.readdir(directory)).flatMap(name => {
      const match = /^([1-9][0-9]*)\.json$/.exec(name);
      return match ? [Number(match[1])] : [];
    }).sort((a, b) => a - b);
    insist(slots.every((slot, index) => slot === index + 1), 'FLEET_MIGRATION_JOURNAL_REFUSED');
    const last = slots.length;
    if (last) {
      const marker = await readRecord(path.join(directory, `${last}.json`));
      insist(runKey.test(marker?.key) && marker.commit === commit && marker.repository === repository &&
        marker.requirementsSha256 === digest && Array.isArray(marker.missing) && marker.missing.length > 0 &&
        plan.filter(row => marker.missing.includes(row.file)).map(row => row.file).join(',') === marker.missing.join(','), code);
      const recorded = await readRecord(path.join(directory, `${last}.run.json`));
      let id;
      if (recorded) {
        insist(recorded.key === marker.key && validId(recorded.id), code);
        id = recorded.id;
      } else {
        const list = api(`${base}/workflows/${workflow}/runs?branch=main&head_sha=${commit}&event=workflow_dispatch&per_page=100`);
        const matches = list?.workflow_runs?.filter(run => run.display_title === runTitle('migrate', marker.key));
        insist(matches?.length === 1 && validId(matches[0].id), 'FLEET_MIGRATION_RUN_UNRESOLVED', { key: marker.key });
        id = matches[0].id;
      }
      const run = await wait(id, 'migrate', marker.key);
      insist(typeof run.conclusion === 'string' && run.conclusion.length > 0,
        'FLEET_MIGRATION_RUN_UNRESOLVED', { id, key: marker.key });
    }
    return { directory, slot: last + 1, digest };
  };

  return {
    admit: () => admitFleetRelease({ api, ...subject }),
    requirements: () => requirements(commit),
    read: async plan => {
      insist(api('user')?.login === RELEASE_OWNER, 'FLEET_RELEASE_PUBLISHER_REFUSED');
      attempt = await readPriorAttempt(plan);
      const key = keyOf();
      return readResult('preflight', dispatch('preflight', key), key, plan);
    },
    migrate: async (missing, plan) => {
      const key = keyOf();
      insist(attempt?.digest === requirementsDigest(plan) && runKey.test(key), code);
      const { directory, slot, digest } = attempt;
      // The create-only, flushed marker is shared by every build on this publisher.
      // If the POST reply is lost, later calls can only rediscover this run by name.
      await persist(path.join(directory, `${slot}.json`), { ...subject, requirementsSha256: digest, key, missing });
      const id = dispatch('migrate', key, missing);
      await persist(path.join(directory, `${slot}.run.json`), { key, id });
      return readResult('migrate', id, key, plan);
    },
  };
}
