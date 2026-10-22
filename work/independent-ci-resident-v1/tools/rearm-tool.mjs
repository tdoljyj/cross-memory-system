// Owner tool for HALT / PAUSE (called by windows/rearm-resident.ps1 from the INSTALLED copy).
//   node rearm-tool.mjs inspect --root <resident root>
//   node rearm-tool.mjs request-rearm  --root <root> --expected-halt-sha256 <sha> --reason <text> --by <sid>
//   node rearm-tool.mjs request-resume --root <root> --expected-paused-sha256 <sha> --by <sid>
//   node rearm-tool.mjs request-abort  --root <root> --batch-key <key> --expected-ledger-entry-sha256 <sha> --reason <text> --by <sid>
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
import { ABORT_CONTRACT, REARM_CONTRACT, RESUME_CONTRACT, validateAbortRequest } from '../src/executor.mjs';
import { nonce, writeNew } from '../src/store.mjs';

const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;

export async function inspect({ ledger, receipts }) {
  const halt = await ledger.halted();
  const paused = await ledger.paused();
  const head = await receipts.verify();
  const open = await ledger.open();
  // Every open batch with the exact values an Owner abort names (DESIGN §6.5): its key and the SHA-256 of its latest
  // ledger record. A batch whose abort was already accepted, or that cannot be read, has no target values.
  const abortTargets = [];
  for (const e of open) {
    const latest = HEX64.test(e.key ?? '') ? await ledger.latestRecord(e.key) : null;
    abortTargets.push({ batchKey: e.key, state: e.state, waiting: Ledger.resumable(e), aborting: !!e.abort,
      latestLedgerEntry: latest?.name ?? null, ledgerEntrySha256: latest?.sha256 ?? null });
  }
  const key = halt?.value?.facts?.key ?? null;
  const keys = Array.isArray(halt?.value?.facts?.keys) ? halt.value.facts.keys : (key ? [key] : []);
  return {
    haltedKeys: keys, toArchive: (await ledger.unknownUnarchived()).map(e => e.key), quarantined: (await ledger.quarantinedUnarchived()).map(q => q.key),
    halted: !!halt, halt: halt?.value ?? null, haltSha256: halt?.sha256 ?? null,
    paused: !!paused, pausedSha256: paused?.sha256 ?? null,
    openBatches: open.length, abortTargets, haltedBatch: HEX64.test(key ?? '') ? await ledger.state(key) : null, receiptsHead: head,
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

// The Owner abort of one batch (DESIGN §6.5), exactly as windows/rearm-resident.ps1 -Request Abort writes it.
export function abortRequest({ batchKey, expectedLedgerEntrySha256, reason, by }, clock = Date.now) {
  check(HEX64.test(batchKey ?? ''), 'BATCH_KEY_REQUIRED');
  check(HEX64.test(expectedLedgerEntrySha256 ?? ''), 'REVIEWED_LEDGER_ENTRY_SHA_REQUIRED');
  check(typeof reason === 'string' && reason.length > 0 && reason.length <= 200, 'ABORT_REASON_REQUIRED');
  check(SID.test(by ?? ''), 'OWNER_SID_REQUIRED');
  return validateAbortRequest({ contract: ABORT_CONTRACT, batchKey, ledgerEntrySha256: expectedLedgerEntrySha256, reason, by, requestedAt: new Date(clock()).toISOString(), nonce: nonce(8) });
}

export function resumeRequest({ expectedPausedSha256, by }, clock = Date.now) {
  check(HEX64.test(expectedPausedSha256 ?? ''), 'REVIEWED_PAUSE_SHA_REQUIRED');
  check(SID.test(by ?? ''), 'OWNER_SID_REQUIRED');
  return { contract: RESUME_CONTRACT, pausedSha256: expectedPausedSha256, by, requestedAt: new Date(clock()).toISOString(), nonce: nonce(8) };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, 'expected-halt-sha256': { type: 'string' }, 'expected-paused-sha256': { type: 'string' }, reason: { type: 'string' }, by: { type: 'string' },
    'batch-key': { type: 'string' }, 'expected-ledger-entry-sha256': { type: 'string' } } });
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
    } else if (positionals[0] === 'request-abort') {
      const file = await writeOwnerRequest(path.join(values.root, 'owner'), abortRequest({ batchKey: values['batch-key'], expectedLedgerEntrySha256: values['expected-ledger-entry-sha256'], reason: values.reason, by: values.by }));
      console.log(JSON.stringify({ status: 'ABORT_REQUESTED_SERVICE_WILL_VERIFY', file }));
    } else {
      check(false, 'MODE_REQUIRED');
    }
  } catch (error) {
    console.log(JSON.stringify({ status: 'REFUSED', code: error.code ?? 'UNCONFIRMED' }));
    process.exitCode = 1;
  }
}
