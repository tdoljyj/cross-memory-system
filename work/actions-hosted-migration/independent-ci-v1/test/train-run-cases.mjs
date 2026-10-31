// The shared train-run /2 table (fixtures/train-run-cases.json) as jobs: train-run.test.mjs checks them against
// validateTrainRun, test-pure-v2.ps1 hands the same jobs to FormalPublicBoundaryV2.cs#ValidateTrainRun.
import fs from 'node:fs';
import { makeTrainRun, trainRunJobId, validateTrainRun } from '../src/resident-v2/train-run.mjs';

export function trainRunCases() {
  const table = JSON.parse(fs.readFileSync(new URL('./fixtures/train-run-cases.json', import.meta.url), 'utf8'));
  const build = c => {
    const job = makeTrainRun(table.base);
    Object.assign(job, c.set ?? {});
    if (c.remove) delete job[c.remove];
    Object.assign(job, c.add ?? {});
    if (!c.keepId) job.id = trainRunJobId(job);
    return job;
  };
  const rows = [...table.accepted.map(c => ({ name: c.name, accepted: true, job: build(c) })), ...table.refused.map(c => ({ name: c.name, accepted: false, job: build(c) }))];
  for (const r of rows) {
    let ok = true;
    try { validateTrainRun(r.job); } catch { ok = false; }
    if (ok !== r.accepted) throw new Error(`SHARED_TRAIN_RUN_CASE_CHANGED:${r.name}`);
  }
  return rows;
}
