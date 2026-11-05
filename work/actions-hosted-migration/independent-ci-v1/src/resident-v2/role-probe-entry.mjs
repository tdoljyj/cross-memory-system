// C2 controller entry. Only the role-gated holders READ RPC. No App key, GitHub, admission/evaluate,
// PR, claim, lease mutation or meter. Generic helper still owns the native timer and complete cleanup.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../proof.mjs';
import { assertProtectedPaths, readProtected } from '../../runtime/protected-files.mjs';
import { createMergeSlotNative } from '../independent-control-checks-v2/merge-slot-native.mjs';
import { nativeReadPost, runEntry } from './entry-runtime.mjs';
import { withReadRetry } from '../read-retry.mjs';
import { WIN_ROOT } from './layout.mjs';

// Generation 11 (resident DESIGN 55): the holders read is repeated on a 5xx or a network failure (read-retry.mjs), inside the entry's
// own deadline (live), like every other read of a controller entry.
export async function probeRole({ record, live, tokenReader = readProtected, protect = assertProtectedPaths, fetchImpl = globalThis.fetch, readRetry = {} }) {
  live();
  const file = path.join(WIN_ROOT, 'secrets', 'ci-admission.token');
  await protect(WIN_ROOT, [file]);
  const token = (await tokenReader(file, { secret: true, secretRoot: path.join(WIN_ROOT, 'secrets'), controllerSid: record.accepted.node.controllerSid })).trim();
  if (!/^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(token) || digest('clued.independent-ci.ci-binding-pin/1\0' + token) !== record.accepted.ciTokenPinSha256)
    throw Object.assign(new Error('ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED'), { code: 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' });
  // Each repeat keeps the probe's own 10 s bound (merge-slot-native.mjs). No log port here: the outcome's code says what was seen.
  const reads = withReadRetry((url, opts) => { live(); return fetchImpl(url, opts); }, { live, deadlineAt: () => live.deadlineAt ?? null, attemptTimeoutMs: 10_000,
    readPost: nativeReadPost(record.config.supabaseUrl), ...readRetry });
  const native = createMergeSlotNative({ config: record.config, nativeToken: token, fetchImpl: reads });
  const fact = await native.roleProbe();
  live();
  return { status: 'BLOCKED', reason: fact.code, sideEffects: 0 };
}
export const main = (argv = process.argv.slice(2), output = process.stdout) => runEntry({ argv, entryRole: 'role-probe', moduleUrl: import.meta.url,
  successStatuses: ['BLOCKED'], output, body: ({ inputs, live }) => probeRole({ record: inputs.record, live }) });
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
