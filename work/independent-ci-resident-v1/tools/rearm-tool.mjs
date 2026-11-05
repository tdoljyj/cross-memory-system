// Owner tool for HALT / PAUSE (called by windows/rearm-resident.ps1 from the INSTALLED copy).
//   node rearm-tool.mjs inspect --root <resident root>
//   node rearm-tool.mjs request-rearm  --root <root> --expected-halt-sha256 <sha> --reason <text> --by <sid>
//   node rearm-tool.mjs request-resume --root <root> --expected-paused-sha256 <sha> --by <sid>
//   node rearm-tool.mjs request-abort  --root <root> --batch-key <key> --expected-ledger-entry-sha256 <sha> --reason <text> --by <sid>
//   node rearm-tool.mjs request-drain  --root <root> --reason <text> --by <sid>   (phase 2: end every parked batch, before a reinstall)
//   node rearm-tool.mjs request-release-breaker --root <root> --reason <text> --by <sid>   (generation 10, DESIGN 53.4: an open breaker's
//     trial is due now; windows/rearm-resident.ps1 -Request ReleaseBreaker writes the same body)
//   node rearm-tool.mjs request-intake-pause  --root <root> --reason <text> [--minutes 1-120] [--holder owner]
//   node rearm-tool.mjs request-intake-resume --root <root> --reason <text> [--holder owner]
//     (primary/standby C6, DESIGN §20: start no new batch for at most two hours; nothing running or parked is touched.
//     Any Owner session may write these, unelevated: they go to the user-writable requests\ directory, like a pause.)
//   node rearm-tool.mjs request-probe       --root <root> --reason <text>   ("立即探测", DESIGN §41.8: the probe only runs sooner)
//   node rearm-tool.mjs request-revoke-head --root <root> --reason <text>   ("撤车头", §41.3: the next stage 10 revokes the front's green)
//     (resident-requests.mjs; requests\ too, unelevated; a request older than an hour is refused by the service)
//   node rearm-tool.mjs mark-train-shadow-reviewed --root <root> --ref <text>
//     (§41.9 step 3, §41.7: the Owner reviewed the shadow data before the train goes on; from then on stage 10 keeps train-shadow
//     90 days. One create-only mark in owner\train-review\, the folder the Owner may write and clued-control may read.)
// inspect writes nothing and needs no elevation (state is Owner-readable); it also shows the in-place upgrade channel (DESIGN §34:
// upgrade\current.json, upgrade\status.json, the Linux version facts), which upgrade\ lets the Owner read. The request modes write
// exactly one small create-only JSON file into the admin-only owner\ directory and nothing else:
// no archive, no ledger write, no rename. The service then carries the request out with its own
// limited rights (quiescence on both hosts, rename-only archive, HALT compare-and-swap), so no file
// operation on an Owner-writable tree ever runs elevated (independent review X1). The intake requests are the exception
// in where they go (requests\, see above), never in what they may do: they only hold new batches.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { HEX64, check, parseBoundedJson } from '../src/canonical.mjs';
import { Ledger } from '../src/ledger.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { Inbox } from '../src/inbox.mjs';
import { ABORT_CONTRACT, BREAKER_RELEASE_CONTRACT, DRAIN_CONTRACT, REARM_CONTRACT, RESUME_CONTRACT, validateAbortRequest } from '../src/executor.mjs';
import { breakerOf, breakerView } from '../src/breaker.mjs';
import { QUEUE_FILE, QUEUE_MAX_BYTES } from '../src/queue.mjs';
import { nonce, readBounded, writeNew } from '../src/store.mjs';
import { readVersionInputs, versionsView } from '../src/status.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { intakePauseRequest, intakeResumeRequest, readIntakePause } from '../src/intake-pause.mjs';
import { probeRequest, revokeHeadRequest } from '../src/resident-requests.mjs';

const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
// The review mark Source v2 stage 10 reads (state-retention.mjs TRAIN_REVIEW_*; a test keeps the two equal).
export const TRAIN_REVIEW_CONTRACT = 'clued.independent-ci.train-shadow-reviewed/1';
export const TRAIN_REVIEW_PATH = Object.freeze(['owner', 'train-review', 'train-shadow-reviewed.json']);

// The two requests\ requests of the merge train (resident-requests.mjs), with the reason the Owner gives.
export function residentRequest(kind, { reason }, clock = Date.now) {
  check(typeof reason === 'string' && reason.length > 0 && reason.length <= 200, 'RESIDENT_REQUEST_REASON_REQUIRED');
  return (kind === 'probe' ? probeRequest : revokeHeadRequest)({ reason }, clock);
}

// The Owner's train-shadow review mark, written once (create-only: a second review refuses, the first one stands).
export function trainShadowReviewMark({ ref }, clock = Date.now) {
  check(typeof ref === 'string' && ref.length >= 1 && ref.length <= 200, 'TRAIN_REVIEW_REF_REQUIRED');
  return { contract: TRAIN_REVIEW_CONTRACT, reviewedAt: new Date(clock()).toISOString(), ref };
}
export async function writeTrainShadowReview(root, mark) {
  const file = path.join(root, ...TRAIN_REVIEW_PATH);
  await writeNew(file, mark);
  return file;
}

// Task 42fe5ae4: where the last Windows step of the upgrade failed and what upgrade-apply.ps1 said (status.json op.lastFailure). Only the fixed
// shapes the upgrader itself writes are shown (step/where: lower-case words; codes: UPPER_CASE; applyAt: the short id alphabet), else null.
const FAILURE_WORD = /^[a-z][a-z0-9-]{0,40}$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,79}$/;
const FAILURE_AT = /^[A-Za-z0-9_.:-]{1,80}$/;
export function failureView(f) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return null;
  const word = v => (typeof v === 'string' && FAILURE_WORD.test(v) ? v : null);
  const code = v => (typeof v === 'string' && FAILURE_CODE.test(v) ? v : null);
  const at = v => (typeof v === 'string' && FAILURE_AT.test(v) ? v : null);
  const view = { step: word(f.step), code: code(f.code), where: word(f.where), applyCode: code(f.applyCode), applyAt: at(f.applyAt) };
  return Object.values(view).every(v => v === null) ? null : view;
}

// The in-place upgrade channel as inspect shows it (DESIGN §34), read-only and leniently (a file that cannot be read is null):
// the generation upgrade\current.json names, the upgrader's op (state, phase, code, the Owner's confirm page while it waits for
// the grant), its recent endings and the generations it keeps, the Linux side's version facts, and whether both sides agree.
export async function inspectUpgrade(root, policy = null, clock = Date.now) {
  const { current, facts, status } = await readVersionInputs(root);
  const view = policy ? versionsView({ current, facts, status }, { policy, now: clock() }) : null;
  const op = status?.op && typeof status.op === 'object' ? status.op : null;
  return {
    generation: Number.isSafeInteger(current?.generation) ? current.generation : null,
    packageManifestSha256: typeof current?.packageManifestSha256 === 'string' ? current.packageManifestSha256 : null,
    linux: facts ? { generation: facts.generation ?? null, manifestSha256: facts.manifestSha256 ?? null, ciSourceManifestSha256: facts.ciSourceManifestSha256 ?? null,
      pinsOk: facts.pinsOk === true, observedAt: facts.observedAt ?? null } : null,
    consistent: view ? view.consistent : null,
    op: op ? { opId: op.opId ?? null, state: op.state ?? null, phase: op.phase ?? null, phaseSince: op.phaseSince ?? null, code: op.code ?? null,
      fromGeneration: op.fromGeneration ?? null, toGeneration: op.toGeneration ?? null, confirmUrl: view?.upgrade?.confirmUrl ?? null, pausedBy: op.pausedBy ?? null,
      lastFailure: failureView(op.lastFailure) } : null,
    recent: Array.isArray(status?.recent) ? status.recent.slice(0, 10) : [],
    generations: Array.isArray(status?.generations) ? status.generations.slice(0, 20) : [],
    statusWrittenAt: status?.writtenAt ?? null,
  };
}

// Generation 10 (DESIGN 53.4): the run queue's breaker as the status board shows it (breaker.mjs#breakerView), read from state\queue\
// queue.json; null when it cannot be read (the service then still has its own; inspect never decides anything).
export async function readBreakerView(state) {
  try {
    const q = parseBoundedJson(await readBounded(path.join(state, 'queue', QUEUE_FILE), QUEUE_MAX_BYTES, 'QUEUE_UNREADABLE'), QUEUE_MAX_BYTES, 'QUEUE_UNREADABLE');
    return breakerView(breakerOf(q?.breaker));
  } catch { return null; }
}

export async function inspect({ ledger, receipts, intake = null, upgrade = null, breaker = null }) {
  const halt = await ledger.halted();
  const paused = await ledger.paused();
  const head = await receipts.verify();
  const open = await ledger.open();
  // Every open batch with the exact values an Owner abort names (DESIGN §6.5): its key and the SHA-256 of its latest
  // ledger record. A batch whose abort was already accepted, or that cannot be read, has no target values.
  const abortTargets = [];
  for (const e of open) {
    const latest = HEX64.test(e.key ?? '') ? await ledger.latestRecord(e.key) : null;
    abortTargets.push({ batchKey: e.key, state: e.state, waiting: Ledger.waitingAt(e), parked: Ledger.parkedAt(e), aborting: !!e.abort,
      latestLedgerEntry: latest?.name ?? null, ledgerEntrySha256: latest?.sha256 ?? null });
  }
  const key = halt?.value?.facts?.key ?? null;
  const keys = Array.isArray(halt?.value?.facts?.keys) ? halt.value.facts.keys : (key ? [key] : []);
  return {
    haltedKeys: keys, toArchive: (await ledger.unknownUnarchived()).map(e => e.key), quarantined: (await ledger.quarantinedUnarchived()).map(q => q.key),
    halted: !!halt, halt: halt?.value ?? null, haltSha256: halt?.sha256 ?? null,
    paused: !!paused, pausedSha256: paused?.sha256 ?? null,
    // The intake pause's holds as the service last wrote them (null: none recorded; `unreadable` when the file does not
    // validate, which the service turns into a two-hour hold of holder `unreadable`).
    intakePause: intake,
    openBatches: open.length, abortTargets, haltedBatch: HEX64.test(key ?? '') ? await ledger.state(key) : null, receiptsHead: head,
    // The in-place upgrade channel (inspectUpgrade; null when the caller read nothing of it).
    upgrade,
    // Generation 10: the breaker an Owner release (-Request ReleaseBreaker) would act on (null when the caller read nothing of it).
    breaker,
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

// Phase 2, step 2: end every batch at a parking point (A or B) on the Owner abort's path, before a reinstall (the
// uninstall refuses an open batch). The service carries it out at its next tick start.
export function drainRequest({ reason, by }, clock = Date.now) {
  check(typeof reason === 'string' && reason.length > 0 && reason.length <= 200, 'DRAIN_REASON_REQUIRED');
  check(SID.test(by ?? ''), 'OWNER_SID_REQUIRED');
  return { contract: DRAIN_CONTRACT, reason, by, requestedAt: new Date(clock()).toISOString(), nonce: nonce(8) };
}

// Generation 10 (DESIGN 53.4): the Owner's early release of an open breaker, exactly as windows/rearm-resident.ps1 -Request ReleaseBreaker writes it.
export function breakerReleaseRequest({ reason, by }, clock = Date.now) {
  check(typeof reason === 'string' && reason.length > 0 && reason.length <= 200, 'BREAKER_RELEASE_REASON_REQUIRED');
  check(SID.test(by ?? ''), 'OWNER_SID_REQUIRED');
  return { contract: BREAKER_RELEASE_CONTRACT, reason, by, requestedAt: new Date(clock()).toISOString(), nonce: nonce(8) };
}

export function resumeRequest({ expectedPausedSha256, by }, clock = Date.now) {
  check(HEX64.test(expectedPausedSha256 ?? ''), 'REVIEWED_PAUSE_SHA_REQUIRED');
  check(SID.test(by ?? ''), 'OWNER_SID_REQUIRED');
  return { contract: RESUME_CONTRACT, pausedSha256: expectedPausedSha256, by, requestedAt: new Date(clock()).toISOString(), nonce: nonce(8) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, 'expected-halt-sha256': { type: 'string' }, 'expected-paused-sha256': { type: 'string' }, reason: { type: 'string' }, by: { type: 'string' },
    'batch-key': { type: 'string' }, 'expected-ledger-entry-sha256': { type: 'string' }, holder: { type: 'string' }, minutes: { type: 'string' }, ref: { type: 'string' } } });
  try {
    check(typeof values.root === 'string' && path.isAbsolute(values.root), 'ROOT_REQUIRED');
    const state = path.join(values.root, 'state');
    if (positionals[0] === 'inspect') {
      const ledger = new Ledger(state, Date.now);
      // The installed policy names what the Windows side runs; without it the upgrade view still shows the files, but no agreement.
      let policy = null;
      try { policy = validatePolicy(parseBoundedJson(await readBounded(path.join(values.root, 'config', 'policy.json'), 65536, 'POLICY_UNREADABLE'), 65536, 'POLICY_UNREADABLE')); } catch { policy = null; }
      console.log(JSON.stringify(await inspect({ ledger, receipts: new ReceiptChain(path.join(state, 'receipts'), Date.now), intake: await readIntakePause(state),
        upgrade: await inspectUpgrade(values.root, policy), breaker: await readBreakerView(state) }), null, 2));
    } else if (positionals[0] === 'request-rearm') {
      const file = await writeOwnerRequest(path.join(values.root, 'owner'), rearmRequest({ expectedHaltSha256: values['expected-halt-sha256'], reason: values.reason, by: values.by }));
      console.log(JSON.stringify({ status: 'REARM_REQUESTED_SERVICE_WILL_VERIFY_AND_ARCHIVE', file }));
    } else if (positionals[0] === 'request-resume') {
      const file = await writeOwnerRequest(path.join(values.root, 'owner'), resumeRequest({ expectedPausedSha256: values['expected-paused-sha256'], by: values.by }));
      console.log(JSON.stringify({ status: 'RESUME_REQUESTED', file }));
    } else if (positionals[0] === 'request-drain') {
      const file = await writeOwnerRequest(path.join(values.root, 'owner'), drainRequest({ reason: values.reason, by: values.by }));
      console.log(JSON.stringify({ status: 'DRAIN_REQUESTED_SERVICE_WILL_END_PARKED_BATCHES', file }));
    } else if (positionals[0] === 'request-release-breaker') {
      const file = await writeOwnerRequest(path.join(values.root, 'owner'), breakerReleaseRequest({ reason: values.reason, by: values.by }));
      console.log(JSON.stringify({ status: 'BREAKER_RELEASE_REQUESTED_SERVICE_WILL_VERIFY', file }));
    } else if (positionals[0] === 'request-intake-pause') {
      check(values.minutes === undefined || /^[0-9]{1,3}$/.test(values.minutes), 'INTAKE_REQUEST_REFUSED');
      const file = await writeOwnerRequest(path.join(values.root, 'requests'), intakePauseRequest({ holder: values.holder ?? 'owner',
        minutes: values.minutes === undefined ? undefined : Number(values.minutes), reason: values.reason }));
      console.log(JSON.stringify({ status: 'INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES', file }));
    } else if (positionals[0] === 'request-intake-resume') {
      const file = await writeOwnerRequest(path.join(values.root, 'requests'), intakeResumeRequest({ holder: values.holder ?? 'owner', reason: values.reason }));
      console.log(JSON.stringify({ status: 'INTAKE_RESUME_REQUESTED', file }));
    } else if (positionals[0] === 'request-probe' || positionals[0] === 'request-revoke-head') {
      const probe = positionals[0] === 'request-probe';
      const file = await writeOwnerRequest(path.join(values.root, 'requests'), residentRequest(probe ? 'probe' : 'revoke-head', { reason: values.reason }));
      console.log(JSON.stringify({ status: probe ? 'PROBE_REQUESTED' : 'REVOKE_HEAD_REQUESTED_NEXT_STAGE_10_WILL_REVOKE', file }));
    } else if (positionals[0] === 'mark-train-shadow-reviewed') {
      const file = await writeTrainShadowReview(values.root, trainShadowReviewMark({ ref: values.ref }));
      console.log(JSON.stringify({ status: 'TRAIN_SHADOW_REVIEW_MARKED', file }));
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
