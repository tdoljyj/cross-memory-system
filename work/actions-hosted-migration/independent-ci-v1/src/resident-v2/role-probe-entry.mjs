// C2 controller entry. Only the role-gated holders READ RPC. No App key, GitHub, admission/evaluate,
// PR, claim, lease mutation or meter. Generic helper still owns the native timer and complete cleanup.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../proof.mjs';
import { assertProtectedPaths, readProtected } from '../../runtime/protected-files.mjs';
import { createMergeSlotNative } from '../independent-control-checks-v2/merge-slot-native.mjs';
import { runEntry } from './entry-runtime.mjs';
import { WIN_ROOT } from './layout.mjs';

export async function probeRole({ record, live, tokenReader = readProtected, protect = assertProtectedPaths, fetchImpl = globalThis.fetch }) {
  live();
  const file = path.join(WIN_ROOT, 'secrets', 'ci-admission.token');
  await protect(WIN_ROOT, [file]);
  const token = (await tokenReader(file, { secret: true, secretRoot: path.join(WIN_ROOT, 'secrets'), controllerSid: record.accepted.node.controllerSid })).trim();
  if (!/^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(token) || digest('clued.independent-ci.ci-binding-pin/1\0' + token) !== record.accepted.ciTokenPinSha256)
    throw Object.assign(new Error('ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED'), { code: 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' });
  const native = createMergeSlotNative({ config: record.config, nativeToken: token, fetchImpl: (url, opts) => { live(); return fetchImpl(url, opts); } });
  const fact = await native.roleProbe();
  live();
  return { status: 'BLOCKED', reason: fact.code, sideEffects: 0 };
}
export const main = (argv = process.argv.slice(2), output = process.stdout) => runEntry({ argv, entryRole: 'role-probe', moduleUrl: import.meta.url,
  successStatuses: ['BLOCKED'], output, body: ({ inputs, live }) => probeRole({ record: inputs.record, live }) });
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
