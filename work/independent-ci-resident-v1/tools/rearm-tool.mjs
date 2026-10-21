// Owner tool for HALT / PAUSE (called by windows/rearm-resident.ps1 from the INSTALLED copy).
//   node rearm-tool.mjs inspect --root <resident root>
//   node rearm-tool.mjs request-rearm  --root <root> --expected-halt-sha256 <sha> --reason <text> --by <sid>
//   node rearm-tool.mjs request-resume --root <root> --expected-paused-sha256 <sha> --by <sid>
// inspect writes nothing and needs no elevation (state is Owner-readable). The request modes write
// exactly one small create-only JSON file into the admin-only owner\ directory and nothing else:
// no archive, no ledger write, no rename. The service then carries the request out with its own
// limited rights (quiescence on both hosts, rename-only archive, HALT compare-and-swap), so no file
// operation on an Owner-writable tree ever runs elevated (independent review X1).
import path from 'node:path';
import { parseArgs } from 'node:util';
import { HEX64, check } from '../src/canonical.mjs';
import { Ledger } from '../src/ledger.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { Inbox } from '../src/inbox.mjs';
import { REARM_CONTRACT, RESUME_CONTRACT } from '../src/executor.mjs';
import { nonce, writeNew } from '../src/store.mjs';

const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;

export async function inspect({ ledger, receipts }) {
  const halt = await ledger.halted();
  const paused = await ledger.paused();
  const head = await receipts.verify();
  const open = await ledger.open();
  const key = halt?.value?.facts?.key ?? null;
  const keys = Array.isArray(halt?.value?.facts?.keys) ? halt.value.facts.keys : (key ? [key] : []);
  return {
    haltedKeys: keys, toArchive: (await ledger.unknownUnarchived()).map(e => e.key), quarantined: (await ledger.quarantinedUnarchived()).map(q => q.key),
    halted: !!halt, halt: halt?.value ?? null, haltSha256: halt?.sha256 ?? null,
    paused: !!paused, pausedSha256: paused?.sha256 ?? null,
    openBatches: open.length, haltedBatch: HEX64.test(key ?? '') ? await ledger.state(key) : null, receiptsHead: head,
  };
}

export async function writeOwnerRequest(ownerDir, value, clock = Date.now) {
  const file = path.join(ownerDir, Inbox.fileName(clock()));
  await writeNew(file, value);
  return file;
}

export function rearmRequest({ expectedHaltSha256, reason, by }, clock = Date.now) {
  check(HEX64.test(expectedHaltSha256 ?? ''), 'REVIEWED_HALT_SHA_REQUIRED');
  check(typeof reason === 'string' && reason.length > 0 && reason.length <= 200, 'REARM_REASON_REQUIRED');
  check(SID.test(by ?? ''), 'OWNER_SID_REQUIRED');
  return { contract: REARM_CONTRACT, haltSha256: expectedHaltSha256, reason, by, requestedAt: new Date(clock()).toISOString(), nonce: nonce(8) };
}

export function resumeRequest({ expectedPausedSha256, by }, clock = Date.now) {
  check(HEX64.test(expectedPausedSha256 ?? ''), 'REVIEWED_PAUSE_SHA_REQUIRED');
  check(SID.test(by ?? ''), 'OWNER_SID_REQUIRED');
  return { contract: RESUME_CONTRACT, pausedSha256: expectedPausedSha256, by, requestedAt: new Date(clock()).toISOString(), nonce: nonce(8) };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, 'expected-halt-sha256': { type: 'string' }, 'expected-paused-sha256': { type: 'string' }, reason: { type: 'string' }, by: { type: 'string' } } });
  try {
    check(typeof values.root === 'string' && path.isAbsolute(values.root), 'ROOT_REQUIRED');
    const state = path.join(values.root, 'state');
    if (positionals[0] === 'inspect') {
      const ledger = new Ledger(state, Date.now);
      console.log(JSON.stringify(await inspect({ ledger, receipts: new ReceiptChain(path.join(state, 'receipts'), Date.now) }), null, 2));
    } else if (positionals[0] === 'request-rearm') {
      const file = await writeOwnerRequest(path.join(values.root, 'owner'), rearmRequest({ expectedHaltSha256: values['expected-halt-sha256'], reason: values.reason, by: values.by }));
      console.log(JSON.stringify({ status: 'REARM_REQUESTED_SERVICE_WILL_VERIFY_AND_ARCHIVE', file }));
    } else if (positionals[0] === 'request-resume') {
      const file = await writeOwnerRequest(path.join(values.root, 'owner'), resumeRequest({ expectedPausedSha256: values['expected-paused-sha256'], by: values.by }));
      console.log(JSON.stringify({ status: 'RESUME_REQUESTED', file }));
    } else {
      check(false, 'MODE_REQUIRED');
    }
  } catch (error) {
    console.log(JSON.stringify({ status: 'REFUSED', code: error.code ?? 'UNCONFIRMED' }));
    process.exitCode = 1;
  }
}
