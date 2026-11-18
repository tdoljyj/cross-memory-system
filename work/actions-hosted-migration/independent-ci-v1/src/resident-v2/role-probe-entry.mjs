// C2 controller entry. Only the role-gated holders READ RPC. No App key, GitHub, admission/evaluate,
// claim, lease mutation or meter; no PR is sent anywhere (a queue watch, generation 12, only compares its one PR number with the
// holders reply here). Generic helper still owns the native timer and complete cleanup.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCiCredential } from './ci-principal.mjs';
import { assertProtectedPaths, readProtected } from '../../runtime/protected-files.mjs';
import { createMergeSlotNative } from '../independent-control-checks-v2/merge-slot-native.mjs';
import { nativeReadPost, runEntry } from './entry-runtime.mjs';
import { withReadRetry } from '../read-retry.mjs';
import { WIN_ROOT } from './layout.mjs';
import { ROLE_PROBE_RUN_CONTRACT_WATCH, validWatchPr } from './role-probe-run.mjs';

// Generation 11 (resident DESIGN 55): the holders read is repeated on a 5xx or a network failure (read-retry.mjs), inside the entry's
// own deadline (live), like every other read of a controller entry.
// watchPr (generation 12, resident DESIGN 56.2): the job's watched PR (role-probe-run/2), else null. It changes nothing but the
// held code (merge-slot-native.mjs#parseRoleProbe).
export async function probeRole({ record, live, root = WIN_ROOT, watchPr = null, tokenReader = readProtected, protect = assertProtectedPaths, fetchImpl = globalThis.fetch, readRetry = {} }) {
  live();
  const { nativeToken: token } = await readCiCredential(record, { root, protect, tokenReader });
  // Each repeat keeps the probe's own 10 s bound (merge-slot-native.mjs). No log port here: the outcome's code says what was seen.
  const reads = withReadRetry((url, opts) => { live(); return fetchImpl(url, opts); }, { live, deadlineAt: () => live.deadlineAt ?? null, attemptTimeoutMs: 10_000,
    readPost: nativeReadPost(record.config.supabaseUrl), ...readRetry });
  const native = createMergeSlotNative({ config: record.config, nativeToken: token, fetchImpl: reads });
  const fact = await native.roleProbe({ watchPr: validWatchPr(watchPr) ? watchPr : null });
  live();
  return { status: 'BLOCKED', reason: fact.code, sideEffects: 0 };
}
export const main = (argv = process.argv.slice(2), output = process.stdout) => runEntry({ argv, entryRole: 'role-probe', moduleUrl: import.meta.url,
  successStatuses: ['BLOCKED'], output, body: ({ inputs, live }) => probeRole({ record: inputs.record, live,
    watchPr: inputs.jobs?.[0]?.contract === ROLE_PROBE_RUN_CONTRACT_WATCH ? inputs.jobs[0].watchPr : null }) });
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
