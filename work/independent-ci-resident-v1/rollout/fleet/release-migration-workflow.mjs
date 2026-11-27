import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { admitFleetRelease, insist, RELEASE_OWNER } from './release-admission.mjs';
import { missingMigrations, releaseRequirements, requirementsDigest, SNAPSHOT_LABEL } from './release-migrations.mjs';

const workflow = 'clued-cloud-production-release.yml';
const workflowPath = `.github/workflows/${workflow}`;
const runKey = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const runTitle = (mode, key) => `fleet-release-${mode}-${key}`;
const validId = id => Number.isSafeInteger(id) && id > 0;

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

export function fleetReleaseWorkflow({ repository, commit, directory, runGh, pause = sleep, keyOf = randomUUID, requirements = releaseRequirements }) {
  const base = `repos/${repository}/actions`;
  const dispatchPath = `${base}/workflows/${workflow}/dispatches`;
  const prefix = `.fleet-migration-${commit}-`;
  const subject = { repository, commit };
  let nextSlot;
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
  const wait = async (id, mode, key) => {
    const deadline = AbortSignal.timeout(50 * 60_000);
    for (let i = 0; i < 600 && !deadline.aborted; i++) {
      const run = api(`${base}/runs/${id}`);
      bound(run, id, mode, key);
      if (run.status === 'completed') return run;
      await pause(5000);
    }
    insist(false, 'FLEET_MIGRATION_RUN_UNRESOLVED', { id, key });
  };
  const readResult = async (mode, id, key, plan) => {
    const run = await wait(id, mode, key);
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

  // Persist before the single POST. A lost response or process exit is reconciled
  // by the same run name before an invocation using this build directory can send again.
  const priorAttempt = async () => {
    const slots = (await fs.readdir(directory)).filter(name => name.startsWith(prefix)).map(name => {
      const match = /^([1-9][0-9]*)\.json$/.exec(name.slice(prefix.length));
      insist(match && validId(Number(match[1])), 'FLEET_MIGRATION_JOURNAL_REFUSED');
      return Number(match[1]);
    }).sort((a, b) => a - b);
    insist(slots.every((slot, index) => slot === index + 1), 'FLEET_MIGRATION_JOURNAL_REFUSED');
    nextSlot = slots.length + 1;
    if (!slots.length) return;
    const marker = JSON.parse(await fs.readFile(path.join(directory, `${prefix}${slots.at(-1)}.json`), 'utf8'));
    insist(runKey.test(marker?.key) && marker.commit === commit && marker.repository === repository, 'FLEET_MIGRATION_JOURNAL_REFUSED');
    const list = api(`${base}/workflows/${workflow}/runs?branch=main&head_sha=${commit}&event=workflow_dispatch&per_page=100`);
    const matches = list?.workflow_runs?.filter(run => run.display_title === runTitle('migrate', marker.key));
    insist(matches?.length === 1 && validId(matches[0].id), 'FLEET_MIGRATION_RUN_UNRESOLVED', { key: marker.key });
    const [run] = matches;
    bound(run, run.id, 'migrate', marker.key);
    insist(run.status === 'completed' && typeof run.conclusion === 'string', 'FLEET_MIGRATION_RUN_UNRESOLVED', { id: run.id, key: marker.key });
  };

  return {
    admit: () => admitFleetRelease({ api, ...subject }),
    requirements: () => requirements(commit),
    read: async plan => {
      insist(api('user')?.login === RELEASE_OWNER, 'FLEET_RELEASE_PUBLISHER_REFUSED');
      await priorAttempt();
      const key = keyOf();
      return readResult('preflight', dispatch('preflight', key), key, plan);
    },
    migrate: async (missing, plan) => {
      const key = keyOf();
      insist(validId(nextSlot) && runKey.test(key), 'FLEET_MIGRATION_JOURNAL_REFUSED');
      try {
        await fs.writeFile(path.join(directory, `${prefix}${nextSlot}.json`), JSON.stringify({ ...subject, key, missing }), { flag: 'wx' });
      } catch { insist(false, 'FLEET_MIGRATION_JOURNAL_REFUSED'); }
      return readResult('migrate', dispatch('migrate', key, missing), key, plan);
    },
  };
}
