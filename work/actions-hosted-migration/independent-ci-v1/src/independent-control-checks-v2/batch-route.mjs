// bc982192 (C3, plan 戊): the batch route, how stages 1 and 8 learn the rule of the batch they run. The resident stamps it on the queue
// row when the batch is born (queue.mjs: current.batchRoute; executor.mjs#batchRoute: the train on, stage 10's effective landing route
// push and no scan required from this App any more), carries it on the batch, and the invoker writes it, at the invocation, as one more
// create-only file of the stage directory (invoke-stage.mjs#prepareStageDirectory), next to train-mode.json (train-mode.mjs: the same
// channel, the same reading). 'push': an S = H batch runs on the merge base of its head and main, which stage 1 proves an ancestor of
// both (full-admission-v2.mjs#baseOnMain), and main moving past it ends nothing at stage 8 (publisher.mjs). No file, or anything that
// is not exactly this record, is null: main's tip is the batch base, exactly as on origin/main (the strictest rule), so a missing or
// broken channel can never relax a batch. Stages 2-7 never get this file.
import fs from 'node:fs/promises';
import path from 'node:path';

export const STAGE_BATCH_ROUTE_CONTRACT = 'clued.independent-ci.stage-batch-route/1';
export const STAGE_BATCH_ROUTE_FILE = 'batch-route.json';
// The stages that read it.
export const BATCH_ROUTE_STAGES = Object.freeze([1, 8]);
export const BATCH_ROUTES = Object.freeze(['push']);

// The exact bytes the resident writes (UTF-8, no newline).
export function stageBatchRouteText(batchRoute) {
  if (!BATCH_ROUTES.includes(batchRoute)) throw Object.assign(new Error('BATCH_ROUTE_REFUSED'), { code: 'BATCH_ROUTE_REFUSED' });
  return JSON.stringify({ contract: STAGE_BATCH_ROUTE_CONTRACT, batchRoute });
}

// Pure: the file's bytes (or null when there is none) -> 'push' or null.
export function parseStageBatchRoute(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 256) return null;
  let v;
  try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
  return v !== null && typeof v === 'object' && BATCH_ROUTES.includes(v.batchRoute) && bytes.toString('utf8') === stageBatchRouteText(v.batchRoute) ? v.batchRoute : null;
}

// The stage directory's file, read once by handle (a plain file, one link, bounded); no directory, absent, unreadable or not exactly the
// record: null.
export async function readStageBatchRoute(stageDir) {
  try {
    const file = path.join(stageDir, STAGE_BATCH_ROUTE_FILE);
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 256) return null;
    const h = await fs.open(file, 'r');
    try {
      const b = await h.readFile();
      if ((await h.stat()).ino !== st.ino) return null;
      return parseStageBatchRoute(b);
    } finally { await h.close(); }
  } catch { return null; }
}
