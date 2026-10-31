// Shadow records (resident quota redesign phase 2, step 3c-1; design v0.5 §6 step 4; DESIGN §21.2 item 5): one
// create-only file per stage-10 run under state\v2\train-shadow (clued-control only, acl-model.json). The step-4
// statistics (front green to merge, the second place's wait, front first-run failures, heads per PR, how long GitHub
// takes to recompute a test merge after main moved) are computed offline from these records, never by the executor.
// Step 3c-2b: the record of every mode (facts /2: shadow, on, revoke-only), including the shadow sweeps' would-revoke,
// calls and time (DESIGN §41.9 item 2). Same write discipline as the green ledger: written whole under a temporary name, synced, hard-linked into place.
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical } from '../proof.mjs';
import { validateTrainFacts } from './train-facts.mjs';

const RUN_ID = /^[0-9a-f]{16}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export class TrainShadowStore {
  static async open(directory) {
    const resolved = path.resolve(directory);
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    for (let current = resolved; ; current = path.dirname(current)) {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_train_shadow_directory');
      if (current === path.dirname(current)) break;
    }
    return new TrainShadowStore(resolved);
  }
  constructor(directory) { this.directory = directory; }
  async append(runId, facts) {
    if (!RUN_ID.test(runId ?? '')) fail('invalid_train_run_id');
    validateTrainFacts(facts);
    const name = `${String(Date.parse(facts.at)).padStart(13, '0')}-${runId}.json`;
    const temporary = path.join(this.directory, `${name}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(canonical({ runId, facts })); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, path.join(this.directory, name));
    await fs.unlink(temporary).catch(() => { /* a leftover temporary file is ignored by readers */ });
    return name;
  }
}
