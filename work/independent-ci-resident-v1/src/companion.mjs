// Companion: runs in the Owner's own logon session, NOT elevated (scheduled task, LeastPrivilege).
// It exists only because WSL distributions are registered per Windows user, so the Session-0
// service account cannot reach Ubuntu-24.04, and because the bundle fetch uses the Owner's own git
// credential exactly as today's build-all-bundle.ps1 does (it refuses elevation).
//
// It is a transport, never an authority:
//   - it executes only fixed argv arrays built here from validated ids (no shell, no free text);
//   - the bridge records it moves are hashed/signed and re-validated by both ends (Source v2:
//     protected-job-bridge-v4 relay-public.ps1, relay-record.mjs, windows-issuer.mjs, linux-worker.mjs);
//   - every Linux unit it starts re-checks its own preconditions as root;
//   - its answers to the service only steer classification, and a false "clean" can at worst make
//     the next batch fail at its own root preflight (DoS), never run something unsafe.
import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { BATCH_ID, PROBE_DELIVERY_MS, PROBE_KINDS, quiescenceProbeMs, validatePrune } from './mailbox.mjs';
import { HEX64, check, exactKeys, fail } from './canonical.mjs';
import { JOB_HOST_MIN_TIMEOUT_MS, PR_HEAD_JOB_HOST_GRACE_MS, RUNNER_BUSY_WITH_UNFINISHED_CHILD } from './runner.mjs';
import { pinnedNodeProfile } from './node-profile.mjs';
import { powershellArgv } from './powershell-argv.mjs';
import { TOOL_NOT_RUN, UPGRADE_TIMEOUT_MS, UPGRADE_TOOL_PATH, VERSION_FACTS_REFRESH_MS, responseFromTool, upgradeMailboxRequest, upgradeToolArgs, validateVersionFacts } from './upgrade-mailbox.mjs';
import { SELFCHECK_BUSY_RETRY_MS, SELFCHECK_REFRESH_MS, SELFCHECK_TIMEOUT_MS, selfcheckDocument, writeSelfcheck } from './selfcheck.mjs';
import { ROLES_PUBLIC_LINUX_DIR, ROLES_PUBLIC_NAMES, ROLES_PUBLIC_TIMEOUT_MS, readRolesPublic, rolePublicBytes, rolesPublicCurrent, rolesPublicDocument, rolesPublicWanted, writeRolesPublic } from './roles-public.mjs';

export const COMPANION_CONFIG_CONTRACT = 'clued.independent-ci.resident-companion-config/2';
// The Linux side of the Source v2 bridge spool (protected-job-bridge-v4/mailbox.mjs LINUX_ROOT): only its
// outgoing names are listed, to know when a relay call has something to move.
export const LINUX_OUTGOING = '/var/lib/clued-independent-ci/formal-spool/outgoing';
// Its incoming names, listed only to tell whether a relayed record arrived (DESIGN §25.3).
export const LINUX_INCOMING = '/var/lib/clued-independent-ci/formal-spool/incoming';
// The Linux end of every relay call; a Send* retry waits until none is left running (DESIGN §25.3).
export const RELAY_RECORD_PROCESS = 'protected-job-bridge-v4/relay-record.mjs';
// One WSL read, using the existing env-i/root transport. The old root tool's
// inactive/cgroup/container snapshot does not see a start job waiting on a
// dependency. Check jobs FIRST: an already queued job must not become active
// between an earlier quiet snapshot and an empty jobs list. This is a snapshot,
// not a barrier against a new external producer. Never publish command output.
// systemd v255: systemctl-list-jobs.c (four columns; --no-legend is empty for no
// jobs), core/job.c (the closed type/state sets below). --full prevents ellipses.
const LINUX_QUIESCENCE_PROBE = String.raw`import json,re,subprocess,sys
def collect():
    if len(sys.argv)!=4 or sys.argv[1:3]!=['quiescence','--batch'] or not re.fullmatch(r'[0-9a-f]{16}-[0-9a-f]{12}',sys.argv[3]):
        raise ValueError()
    jobs=subprocess.run(['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager','--plain','--full','clued-ci-worker@*.service','clued-ci-wsprep@*.service','clued-ci-archive@*.service'],capture_output=True,text=True,timeout=5)
    if jobs.returncode!=0 or jobs.stderr or len(jobs.stdout)>262144:
        raise ValueError()
    types={'start','verify-active','stop','reload','reload-or-start','restart','try-restart','try-reload','nop'}
    states={'waiting','running'}
    seen=set()
    quiet=True
    for line in jobs.stdout.splitlines():
        if not line.strip():
            continue
        row=re.fullmatch(r'[ \t]*([1-9][0-9]{0,9})[ \t]+([\x21-\x7e]{1,255})[ \t]+([a-z-]+)[ \t]+([a-z]+)[ \t]*',line)
        if row is None:
            raise ValueError()
        job,unit,kind,state=row.groups()
        if int(job)>4294967295 or job in seen or kind not in types or state not in states:
            raise ValueError()
        if re.fullmatch(r'[-A-Za-z0-9:_.@\\]+\.(?:service|socket|target|device|mount|automount|swap|timer|path|slice|scope)',unit) is None:
            raise ValueError()
        seen.add(job)
        if unit.startswith(('clued-ci-worker@','clued-ci-wsprep@','clued-ci-archive@')):
            if re.fullmatch(r'clued-ci-(?:worker|wsprep|archive)@[0-9a-z_-]{1,120}\.service',unit) is None:
                raise ValueError()
            quiet=False
    if not quiet:
        return {'linuxUnitsInactive':False,'containersZero':False,'pendingJobsQuiet':False}
    root=subprocess.run(['/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux','quiescence','--batch',sys.argv[3]],capture_output=True,text=True,timeout=20)
    if root.returncode!=0 or root.stderr or len(root.stdout)>1048576:
        raise ValueError()
    proof=json.loads(root.stdout)
    if not isinstance(proof,dict) or any(type(proof.get(k)) is not bool for k in ('linuxUnitsInactive','containersZero')):
        raise ValueError()
    return {'linuxUnitsInactive':proof['linuxUnitsInactive'],'containersZero':proof['containersZero'],'pendingJobsQuiet':quiet}
try:
    answer=collect()
except Exception:
    print(json.dumps({'linuxUnitsInactive':False,'containersZero':False,'pendingJobsQuiet':False}))
    sys.exit(2)
print(json.dumps(answer))`;
// One callback round, the same value as protected-job-bridge-v4/protocol.mjs CALLBACK_WINDOW_MS (test-pinned).
export const CALLBACK_WINDOW_MS = 120_000;
// How long the pump waits for one relay call. A relay call usually takes 4-6 s, but sometimes 25-45 s: PR #911 stage 4
// (2026-10-23) lost a 43 s SendIssue to the old fixed 40 s, so no worker was started and the issuer waited out its
// stage into a HALT (Task 576231fa). One callback round is the most a relay call can still help; at this limit the job
// host ends the call with its whole job (DESIGN §24) and the pump goes on to its blocked hand-over.
export const RELAY_TIMEOUT_MS = CALLBACK_WINDOW_MS;
// Bounded relay retries (DESIGN §25.4). Every attempt keeps RELAY_TIMEOUT_MS: a call ended between relay-public.ps1's data
// and ready writes would leave half a record. So only a call that failed fast leaves time for another; each next attempt
// starts only while its budget holds: the stage deadline 150 s ahead, the challenge's first sighting plus one callback
// round less 60 s (the issuer's evaluation and the response), or the challenge's own deadline less 15 s.
export const RELAY_ATTEMPTS = Object.freeze({
  SendIssue: Object.freeze([3000, 8000]), ReceiveResult: Object.freeze([3000, 8000]), ReceiveBlocked: Object.freeze([3000, 8000]),
  ReceiveChallenge: Object.freeze([3000]), SendResponse: Object.freeze([2000]),
}); // the gaps before attempts 2, 3, ...
export const STAGE_RESERVE_MS = 150_000;
export const CHALLENGE_RESERVE_MS = 60_000;
export const RESPONSE_RESERVE_MS = 15_000;
export const RELAY_CHECK_TIMEOUT_MS = 15_000;
// Signals B and C (DESIGN §26): the pump reads the worker unit's facts right after starting it and then every 15 s. A worker
// that has run and ended with nothing left in Linux outgoing ends the pump at once (LINUX_WORKER_ENDED_WITHOUT_RECORD); one
// with no sign of having run 5 minutes after its start ends it as LINUX_WORKER_NOT_STARTED.
export const WORKER_FACTS_EVERY_MS = 15_000;
export const WORKER_START_WAIT_MS = 5 * 60_000;
// How often the pump lists Linux outgoing (DESIGN §31.5, Task 463e8148). Every listing and every facts read starts a wsl.exe, and
// each wsl.exe opens six hv_sock channels: at once a second for a whole stage that was thousands of starts (10-28 incident). The
// pace follows how long nothing has happened (the stage began, the listing changed, a record was relayed): every second right
// after, then half of the quiet time, at most LISTING_CAP_MS. A challenge is therefore found at most LISTING_CAP_MS (plus
// the listing call) after its creation, where it was found within about a second; the cap equals WORKER_FACTS_EVERY_MS so that,
// quiet, one pass does both reads and signals B and C keep their timing. A relay budget measured from the first sighting is
// anchored at a moment the challenge certainly did not exist yet (see pump), so the cap never eats into DESIGN §25.4's reserves.
export const LISTING_MIN_MS = 1000;
export const LISTING_CAP_MS = WORKER_FACTS_EVERY_MS;
export const LISTING_QUIET_DIVISOR = 2;
// Hot window (DESIGN §31.5, the hot-window paragraph): for HOT_WINDOW_MS after a callback round was answered (SendResponse relayed) the
// next challenge is likely to follow soon, so the listing pause is capped at HOT_LISTING_CAP_MS instead of LISTING_CAP_MS. Outside
// the window the back-off is unchanged.
export const HOT_WINDOW_MS = 60_000;
export const HOT_LISTING_CAP_MS = 3000;
// After a failed callback round, the hand-over of the worker's blocked record is looked for at most this far apart (its window
// is CALLBACK_WINDOW_MS + 30 s; DESIGN §31.5).
export const HANDOVER_LISTING_CAP_MS = 5000;
export const listingDelayMs = (quietMs, capMs = LISTING_CAP_MS) => Math.min(capMs, Math.max(LISTING_MIN_MS, Math.floor(quietMs / LISTING_QUIET_DIVISOR)));
const WORKER_RUNNING_STATES = new Set(['activating', 'active', 'deactivating']);
const RELAY_RECEIPT_CONTRACT ='clued.independent-ci.formal-public-relay-receipt/2';
// EAGAIN, ENOMEM and ETIMEDOUT: what the Linux child meets when the WSL VM stalls (a relay call that took 53 s on 2026-11-04
// instead of the usual 3 s, DESIGN §47). They are retried only before the child could have written (the stages below).
const CHILD_TRANSIENT_REASONS = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'EINTR', 'EAGAIN', 'ENOMEM', 'ETIMEDOUT', 'FORMAL_RELAY_STDIN_TIMEOUT']);
const CHILD_TRANSIENT_STAGES = new Set(['OPERATION', 'CONTEXT', 'STDIN', 'TRANSPORT', 'PACKET']);
// A refusal by the bridge protocol's time checks (protocol.mjs validateIssue / validateChallenge / validateResponse /
// validateBlocked), made before the child writes anything: CONTEXT (the issue, read again) or BINDING (the packet against the
// issue and challenge). The two hosts' clocks differ and are stepped (DESIGN §47), so this is a retryable environment failure,
// not a permanent refusal; `arrived` below still settles whether anything reached the target, and the attempts and their
// budgets are the same as for any child failure.
const CHILD_CLOCK_REASONS = new Set(['BRIDGE_ISSUE_EXPIRED', 'BRIDGE_CHALLENGE_EXPIRED', 'BRIDGE_RESPONSE_EXPIRED', 'BRIDGE_BLOCKED_TIME_INVALID']);
const CHILD_CLOCK_STAGES = new Set(['CONTEXT', 'BINDING']);
const AMBIGUOUS_FAILURES = new Set(['PUBLIC_TERMINAL_UNCONFIRMED_LOCKS_RETAINED', 'PUBLIC_OUTPUT_UNCONFIRMED_NO_RETRY', 'PUBLIC_STDIN_UNCERTAIN_NO_RETRY']);
const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The record a relay call moves: relay-public.ps1's own names (one per stage; both ends only create).
export function relayRecordName(mode, seq) {
  const suffix = String(seq).padStart(2, '0');
  return { SendIssue: 'issue', SendResponse: `response-${suffix}`, ReceiveChallenge: `challenge-${suffix}`, ReceiveResult: 'result', ReceiveBlocked: 'blocked' }[mode];
}
export const relaySends = mode => mode === 'SendIssue' || mode === 'SendResponse';

// One relay attempt -> OK | NOT_YET | NO_CHILD | CHILD_FAILED | AMBIGUOUS | EXISTING | PERMANENT (DESIGN §25.2). runner is
// runner.mjs's answer, receipt the parsed stdout of relay-public.ps1. Anything not named here is PERMANENT.
export function classifyRelayAttempt(runner, receipt) {
  const r = runner ?? {};
  // No child ran at all: the job host never started, or it reported started:false with its job drained (no `tree` key).
  if (r.refused === 'RUNNER_SPAWN_FAILED') return 'NO_CHILD';
  if (r.refused === 'JOB_HOST_UNCONFIRMED' && !('tree' in r) && !r.timedOut) return 'NO_CHILD';
  // The job host ended the call at its limit with its whole tree: it may have written.
  if (r.timedOut === true && r.tree === 'zero' && !r.refused) return 'AMBIGUOUS';
  // A tree not shown ended, or any other runner refusal (busy, timeout or argv refused, a host that may still run).
  if (r.tree === 'unconfirmed' || r.refused || r.timedOut) return 'PERMANENT';
  // relay-public.ps1's receipt (contract formal-public-relay-receipt/2): read by its fields, as before (DESIGN §25.2).
  const v = receipt;
  if (!plainObject(v)) return 'PERMANENT';
  if (r.code === 0 && v.status === 'PUBLIC_RECORD_TRANSFERRED' && v.terminalConfirmed === true) return 'OK';
  const ce = plainObject(v.childError) ? v.childError : null;
  if (ce?.reason === 'ENOENT' && v.terminalConfirmed === true) return 'NOT_YET';
  // wsl.exe did not start, or relay-public failed before it: an exception id with no process and no exit code.
  // The classes below may lead to a retry; their safety rests on receipt /2's meaning, so they require its contract.
  if (v.contract !== RELAY_RECEIPT_CONTRACT) return 'PERMANENT';
  if (v.failureCode === 'PUBLIC_TRANSFER_UNCONFIRMED' && v.processId === null && v.exitCode === null) return 'NO_CHILD';
  if (v.terminalConfirmed === true && v.failureCode === 'PUBLIC_CHILD_EXIT_REFUSED_NO_RETRY' && v.childError === null) return 'CHILD_FAILED';
  if (v.terminalConfirmed === true && v.failureCode === 'PUBLIC_CHILD_REFUSED_NO_RETRY' && ce && ((CHILD_TRANSIENT_REASONS.has(ce.reason) && CHILD_TRANSIENT_STAGES.has(ce.stage))
    || (CHILD_CLOCK_REASONS.has(ce.reason) && CHILD_CLOCK_STAGES.has(ce.stage)))) return 'CHILD_FAILED';
  if (AMBIGUOUS_FAILURES.has(v.failureCode) || ce?.reason === 'EEXIST') return 'AMBIGUOUS';
  // A Receive* that found the record already in Windows incoming: settled by the arrival check alone.
  if (v.failureCode === 'EXISTING_RECORD_PRESERVED_NO_RETRY') return 'EXISTING';
  return 'PERMANENT';
}

// The relay log's stderr tail (DESIGN §25.5): printable ASCII only, no user name, no long hex or base64, at most 512 chars.
export function stderrTail(stderr) {
  return String(stderr ?? '').replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, '%USERPROFILE%')
    .replace(/[0-9a-fA-F]{32,}/g, '<hex>')
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, '<b64>')
    .replace(/\s+/g, ' ').trim().slice(-512);
}

// `systemctl show --property=ActiveState,InvocationID,ExecMainStartTimestampMonotonic` (KEY=VALUE per line) -> { activeState,
// invocationId ('' when none), mainStartMonotonic (0 when none) }, or null when the call failed or its output is not that.
export function parseUnitFacts(r) {
  if (!r || r.code !== 0 || 'tree' in r || r.timedOut || r.refused) return null;
  const v = {};
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    const m = /^([A-Za-z]{1,64})=(.*)$/.exec(line.trim());
    if (m && !Object.hasOwn(v, m[1])) v[m[1]] = m[2];
  }
  if (!/^[a-z-]{1,32}$/.test(v.ActiveState ?? '')) return null;
  return { activeState: v.ActiveState, invocationId: /^[0-9a-f]{32}$/.test(v.InvocationID ?? '') ? v.InvocationID : '',
    mainStartMonotonic: /^[0-9]{1,20}$/.test(v.ExecMainStartTimestampMonotonic ?? '') ? Number(v.ExecMainStartTimestampMonotonic) : 0 };
}

// Evidence that the worker unit has really run (DESIGN §26 signal B): right after `start --no-block`, and under load for some
// seconds, the unit reads inactive before systemd runs it, so inactive alone is never "ended". Any one of: seen activating,
// active or deactivating; failed (kept until reset); an invocation id with a main-process start time. (The pump also counts a
// challenge it relayed.)
export const workerRanEvidence = f => !!f && (WORKER_RUNNING_STATES.has(f.activeState) || f.activeState === 'failed' || (f.invocationId !== '' && f.mainStartMonotonic > 0));
// DESIGN 54: a run again starts the same instance (clued-ci-worker@<jobId>) a second time, and the run before left its facts (failed,
// or inactive with its invocation id and start time): they are no evidence for this run. baseline = the facts read before this start;
// only a change from them counts (a new invocation that started its main process or failed, or a running state). 'unread' (the
// baseline could not be read): only a running state counts (the pump's records count anyway). null: a first run, as before.
export function workerRanSince(f, baseline = null) {
  if (baseline === null) return workerRanEvidence(f);
  if (!f) return false;
  if (WORKER_RUNNING_STATES.has(f.activeState)) return true;
  if (baseline === 'unread') return false;
  const fresh = f.invocationId !== '' && f.invocationId !== baseline.invocationId;
  return fresh && (f.mainStartMonotonic > baseline.mainStartMonotonic || f.activeState === 'failed');
}

// The pre-stage memory gate (DESIGN §32, Task 25851665): the same arithmetic as linux/host-tuning/clued-wsl-memguard. Every
// Windows->WSL hv_sock channel needs one free block of the ring order: each direction's socket default clamped to 6..64 pages,
// both in one allocation (order 7 at the 212992-byte defaults, order 5 with host tuning P1). An allocation fails only when no
// zone has such a block, so the count is the free blocks of at least that order summed over the zones of /proc/buddyinfo.
export const MEMORY_FACTS_FILES = Object.freeze(['/proc/sys/net/core/rmem_default', '/proc/sys/net/core/wmem_default', '/proc/buddyinfo']);
export function ringOrder(rmem, wmem) {
  const pages = buf => Math.ceil(Math.min(Math.max(buf, 6 * 4096), 64 * 4096) / 4096);
  return (pages(rmem) + pages(wmem) - 1).toString(2).length;
}
// `cat rmem_default wmem_default buddyinfo` -> { order, blocks }, or null when the text is not exactly that: two sizes, then at
// least one zone line ("Node N, zone NAME" and the free counts of orders 0..10; like memguard, columns past order 10 are ignored).
export function parseMemoryFacts(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
  if (lines.length < 3 || !lines.slice(0, 2).every(l => /^[0-9]{1,10}$/.test(l))) return null;
  const order = ringOrder(Number(lines[0]), Number(lines[1]));
  let blocks = 0, zones = 0;
  for (const line of lines.slice(2)) {
    const p = line.split(/\s+/);
    if (p.length < 15 || p[0] !== 'Node' || p[2] !== 'zone') return null;
    const counts = p.slice(4, 15);
    if (!counts.every(c => /^[0-9]{1,12}$/.test(c))) return null;
    blocks += counts.slice(order).reduce((sum, c) => sum + Number(c), 0);
    zones += 1;
  }
  return zones > 0 && Number.isSafeInteger(blocks) ? { order, blocks } : null;
}

// One log entry per relay attempt: fixed keys, codes and counts only.
export function relayLogEntry({ at, mode, seq, attempt, ms, runner, receipt, klass }) {
  const r = runner ?? {}, v = plainObject(receipt) ? receipt : {};
  const code = s => (typeof s === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(s) ? s : null);
  const ce = plainObject(v.childError) ? { reason: code(v.childError.reason), stage: code(v.childError.stage) } : null;
  const failed = ['BLOCKED', 'UNCERTAIN_LOCKS_RETAINED_NO_RETRY'].includes(v.status) && code(v.failureCode) !== null;
  const failurePhase = failed && ['SOURCE', 'SPOOL', 'CLIENT', 'START', 'TRANSFER', 'RESULT'].includes(v.failurePhase) ? v.failurePhase : null;
  const exceptionCategory = failed && ['IO', 'ACCESS', 'SECURITY', 'ARGUMENT', 'INVALID_OPERATION', 'WIN32', 'OTHER'].includes(v.exceptionCategory) ? v.exceptionCategory : null;
  const exceptionHResult = failed && Number.isInteger(v.exceptionHResult) && v.exceptionHResult >= -2147483648 && v.exceptionHResult <= 2147483647 ? v.exceptionHResult : null;
  return { at: new Date(at).toISOString(), mode, seq, attempt, ms,
    runner: { code: Number.isSafeInteger(r.code) ? r.code : null, timedOut: r.timedOut === true, tree: ['zero', 'unconfirmed'].includes(r.tree) ? r.tree : null, refused: code(r.refused) },
    receipt: { status: code(v.status), failureCode: code(v.failureCode), exitCode: Number.isSafeInteger(v.exitCode) ? v.exitCode : null,
      processIdPresent: v.processId !== null && v.processId !== undefined, terminalConfirmed: v.terminalConfirmed === true, childError: ce, failurePhase, exceptionCategory, exceptionHResult },
    class: klass, stderrTail: stderrTail(r.stderr) };
}

// DESIGN §44: one log entry per read or action asked again after a timeout (fixed keys, codes and counts only), so that the next
// HALT shows which probe had no answer, how often and for how long.
export function retryLogEntry({ at, op, attempt, ms, runner }) {
  const r = runner ?? {};
  return { at: new Date(at).toISOString(), kind: 'retry', op, attempt, ms,
    runner: { code: Number.isSafeInteger(r.code) ? r.code : null, timedOut: r.timedOut === true, tree: ['zero', 'unconfirmed'].includes(r.tree) ? r.tree : null,
      refused: typeof r.refused === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(r.refused) ? r.refused : null } };
}

// DESIGN 52 (Decision 98fec682): build-bundle.ps1's refusal answer may carry one fixed `hint` (a reviewed commit that only a branch keeps
// alive). The companion answers BUNDLE_UNAVAILABLE as before; the hint reaches the operator only through the log entry below, and only
// when it is one of the fixed texts below byte for byte (the same literals as in build-bundle.ps1, Branch-Only-Hint; a test pins both). Any
// other hint is dropped; of the rest of the answer only the codes and counts that bundleRefusalLogEntry names are kept (generation 10).
// Empty since PR #991 brought d94cd486 into main (the script's table is empty too): every hint is dropped.
export const BUNDLE_BRANCH_ONLY_HINTS = Object.freeze([]);
// Generation 10 (DESIGN 53.1, Task 125a5162 item 1): EVERY bundle that was not written leaves one entry, so the cause of a
// BUNDLE_UNAVAILABLE is visible (on 2026-11-05 two refused bundles burned a head and the log said nothing). Only codes and counts are
// kept, each through its own fixed pattern: the script's status, reason and stage, the last git step (its label, exit code and how many
// characters of stderr it wrote: never the text), the store attempts and every given-up attempt (number, reason, stage, git step,
// seconds; a refs difference only as its count, never the ref names), the seed's use (used, reason code, discarded, networkFailureNoted)
// and the runner's own facts (exit code, timed out, tree, refusal code). A value that does not fit its pattern is null; nothing else of
// the script's output (paths, created directories, any free text) is ever written. The hint stays the one fixed text or null.
const BUNDLE_CODE = /^[A-Z][A-Z0-9_]{1,79}$/, BUNDLE_SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const bundleCode = s => (typeof s === 'string' && BUNDLE_CODE.test(s) ? s : null);
const bundleSlug = s => (typeof s === 'string' && BUNDLE_SLUG.test(s) ? s : null);
const bundleCount = n => (Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000 ? n : null);
const bundleExit = n => (Number.isSafeInteger(n) && n >= -2_147_483_648 && n <= 4_294_967_295 ? n : null);
const bundleGit = g => (plainObject(g) ? { label: bundleSlug(g.label), exitCode: bundleExit(g.exitCode), stderrChars: bundleCount(g.stderrChars) } : null);
export const BUNDLE_LOG_ATTEMPTS_MAX = 3;
// Generation 10 (DESIGN 53.1, 53.3): the steps of build-bundle.ps1 whose failure in git counts as the line. A refusal whose own reason is
// that one of them failed in git (stderr is never read) is answered with BUNDLE_NETWORK_UNAVAILABLE instead of BUNDLE_UNAVAILABLE, so the
// executor can tell the line from every other refusal of the script (a ref that fails its checks, main moved, a commit missing, a timeout,
// the script's own fault), which keep the release cap. Only the whole fetch and the ls-remote: the by-SHA fetches of the reviewed
// commits and of S (fetch-reviewed, fetch-test; the script retries them like the others, $NetworkSteps) run after both of those
// succeeded in the same attempt, so a failure there is much more likely a commit GitHub no longer serves (a deleted branch, a test merge
// GitHub dropped) than the line: it stays BUNDLE_UNAVAILABLE.
export const BUNDLE_NETWORK_STEPS = Object.freeze(['fetch', 'ls-remote']);
// ADR 0019 (review 2): build-bundle.ps1's refusals of a batch of several PRs that say a member moved on after stage 10 composed the
// batch (its branch no longer at the member's head, or GitHub's PR head another commit). Nothing about the front or the node was
// decided: the executor releases the batch like a supersession (TRAIN_BATCH_MEMBER_MOVED: no release cap, no breaker) and drops
// that S; stage 10 composes again. Every other refusal stays BUNDLE_UNAVAILABLE.
export const BUNDLE_MEMBER_MOVED_REASONS = Object.freeze(['BATCH_MEMBER_NOT_BRANCH_TIP', 'BATCH_MEMBER_NOT_PR_HEAD']);
export const TRAIN_BATCH_MEMBER_MOVED = 'TRAIN_BATCH_MEMBER_MOVED';
export const BUNDLE_NETWORK_UNAVAILABLE = 'BUNDLE_NETWORK_UNAVAILABLE';
// Field defect 2026-11-14 (TURING, PRs #594/#942): main moved while a head waited in the run queue with the old main as its base. The
// script then fetched GitHub's refs, found refs/heads/main is not the descriptor's base and refused (REMOTE_MAIN_BASE_CHANGED). That is
// a checked fact about this one subject, which can never pass with that base, not about the node: it is answered as RESIDENT_BASE_MOVED
// (the code stage 8 uses for the same fact), so the executor stops that row alone instead of counting it towards the breaker.
export const BUNDLE_BASE_MOVED_REASONS = Object.freeze(['REMOTE_MAIN_BASE_CHANGED']);
export const RESIDENT_BASE_MOVED = 'RESIDENT_BASE_MOVED';
export function bundleNetworkRefusal(runner) {
  if (runner?.code !== 2 || typeof runner.stdout !== 'string' || runner.stdout.length > 65_536) return false;
  let v = null;
  try { v = JSON.parse(runner.stdout); } catch { return false; }
  return plainObject(v) && v.reason === 'GIT_STEP_FAILED' && plainObject(v.git) && BUNDLE_NETWORK_STEPS.includes(v.git.label) && Number.isSafeInteger(v.git.exitCode) && v.git.exitCode !== 0;
}
export function bundleRefusalLogEntry({ at, op, runner }) {
  const r = plainObject(runner) ? runner : {};
  let v = null;
  if (typeof r.stdout === 'string' && r.stdout.length <= 65_536) { try { v = JSON.parse(r.stdout); } catch { v = null; } }
  if (!plainObject(v)) v = null;
  const attempts = Array.isArray(v?.failedAttempts) ? v.failedAttempts.slice(0, BUNDLE_LOG_ATTEMPTS_MAX).map(a => (plainObject(a)
    ? { attempt: bundleCount(a.attempt), reason: bundleCode(a.reason), stage: bundleSlug(a.stage), git: bundleGit(a.git), failedAfterSeconds: bundleCount(a.failedAfterSeconds),
      refsDiffer: plainObject(a.refsDiffer) ? bundleCount(a.refsDiffer.count) : null }
    : null)) : null;
  const s = plainObject(v?.seed) ? v.seed : null;
  return { at: new Date(at).toISOString(), kind: 'bundle-refusal', op: bundleSlug(op),
    runner: { code: bundleExit(r.code), timedOut: r.timedOut === true, tree: ['zero', 'unconfirmed'].includes(r.tree) ? r.tree : null, refused: bundleCode(r.refused) },
    status: bundleCode(v?.status), reason: bundleCode(v?.reason), stage: bundleSlug(v?.stage), git: bundleGit(v?.git), storeAttempts: bundleCount(v?.storeAttempts),
    failedAttempts: attempts, seed: s ? { used: s.used === true, reason: bundleCode(s.reason), discarded: s.discarded === true, networkFailureNoted: s.networkFailureNoted === true } : null,
    hint: typeof v?.hint === 'string' && BUNDLE_BRANCH_ONLY_HINTS.includes(v.hint) ? v.hint : null };
}

// DESIGN §33 (the 2026-10-29 first HALT): the path-valued keys of companion.json and which of them point into the installed CI
// Source, <root>\source\<ciSourceManifestSha256>\. A path key is a Source script unless it is named here as not one, so a new path
// key is held to the Source directory by default. A config whose script paths name another (older) Source directory runs
// nothing: the stage-0 bundle then reports BUNDLE_UNAVAILABLE and the relay cannot start.
// build-bundle.ps1's refusals that mean the batch's refs moved on since its first bundle (DESIGN §37).
export const REBUNDLE_REFS_CHANGED = Object.freeze(['REMOTE_MAIN_BASE_CHANGED', 'REMOTE_HEAD_MOVED']);
export const COMPANION_PATH_KEYS = Object.freeze(['wslExe', 'powershellExe', 'relayScript', 'bundleScript', 'windowsSpool']);
export const NON_SOURCE_PATH_KEYS = Object.freeze(['wslExe', 'powershellExe', 'windowsSpool']);
export const SOURCE_SCRIPT_KEYS = Object.freeze(COMPANION_PATH_KEYS.filter(k => !NON_SOURCE_PATH_KEYS.includes(k)));
export const RESIDENT_INSTALL_ROOT = 'C:\\ProgramData\\CluedIndependentCI\\resident';
const SCRIPT_SEGMENT = /^[A-Za-z0-9_.@-]+$/;
// The directory the installed CI Source lives in, with its closing backslash (the install puts it at source\<ciSourceManifestSha256>).
export function sourceDirectory(root, ciSourceManifestSha256) {
  check(typeof root === 'string' && /^[A-Za-z]:\\/.test(root) && !root.includes('/'), 'COMPANION_SOURCE_ROOT_INVALID');
  check(HEX64.test(ciSourceManifestSha256 ?? ''), 'COMPANION_SOURCE_HASH_INVALID');
  return `${root.replace(/\\+$/, '')}\\source\\${ciSourceManifestSha256}\\`;
}
// Every Source script path lies under that directory (compared as Windows compares: without regard to case), as a plain chain of
// names: no "." or ".." segment, no empty one. Fixed code and the key's name only; the path is never put in the refusal.
export function assertSourceScripts(c, { root = RESIDENT_INSTALL_ROOT, ciSourceManifestSha256 } = {}) {
  const base = sourceDirectory(root, ciSourceManifestSha256).toLowerCase();
  for (const k of SOURCE_SCRIPT_KEYS) {
    const p = c?.[k];
    const rest = typeof p === 'string' && p.toLowerCase().startsWith(base) ? p.slice(base.length).split('\\') : null;
    check(rest !== null && rest.every(s => SCRIPT_SEGMENT.test(s) && s !== '.' && s !== '..'), 'COMPANION_SCRIPT_NOT_IN_SOURCE', k);
  }
}

// source (optional): { root, ciSourceManifestSha256 } of the install this config belongs to. The package build and the companion's
// start pass it, so a config that points into another Source directory is refused where it is made and where it is loaded.
export function validateCompanionConfig(c, source = null) {
  exactKeys(c, ['contract', 'wslExe', 'powershellExe', 'relayScript', 'bundleScript', 'windowsSpool', 'distribution', 'bridgeManifestSha256', 'linuxTool', 'node', 'nodeProfileSha256'], 'COMPANION_CONFIG_KEYS_INVALID');
  check(c && c.contract === COMPANION_CONFIG_CONTRACT, 'COMPANION_CONFIG_CONTRACT_INVALID');
  for (const k of COMPANION_PATH_KEYS) check(typeof c[k] === 'string' && /^[A-Z]:\\/.test(c[k]), 'COMPANION_CONFIG_PATH_INVALID', k);
  if (source) assertSourceScripts(c, source);
  const node = pinnedNodeProfile(c.node, c.nodeProfileSha256);
  check(c.distribution === node.wslDistribution, 'COMPANION_DISTRIBUTION_FIXED');
  check(HEX64.test(c.bridgeManifestSha256), 'COMPANION_BRIDGE_PIN_INVALID');
  check(c.linuxTool === '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux', 'COMPANION_LINUX_TOOL_FIXED');
  return Object.freeze({ ...c, node });
}

// The frozen Linux upgrade tool's arguments (in-place upgrade channel, Task 018da927, DESIGN §34): exactly one of these lines once
// joined by single spaces, every element a plain token of its own (no space, no quote, no path). upgrade-mailbox.mjs#upgradeToolArgs
// builds them from a validated request; this is the companion's own second check before anything runs as root.
const UPGRADE_UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', UPGRADE_SHA = '[0-9a-f]{64}', UPGRADE_GEN = '[1-9][0-9]{0,9}';
export const UPGRADE_TOOL_ARGV = Object.freeze([
  new RegExp('^version-facts$'),
  new RegExp(`^stage --op ${UPGRADE_UUID} --package ${UPGRADE_SHA} --generation ${UPGRADE_GEN} --linux-manifest ${UPGRADE_SHA}$`),
  new RegExp(`^switch --op ${UPGRADE_UUID} --from ${UPGRADE_GEN} --to ${UPGRADE_GEN} --linux-manifest ${UPGRADE_SHA}$`),
  new RegExp(`^rollback --op ${UPGRADE_UUID} --from ${UPGRADE_GEN} --to ${UPGRADE_GEN}$`),
  new RegExp(`^verify --op ${UPGRADE_UUID} --generation ${UPGRADE_GEN}$`),
  // linux-upgrade-retain { keep, generation }: the root tool keeps 2..10 generations (clued-ci-upgrade-linux retain).
  new RegExp(`^retain --op ${UPGRADE_UUID} --keep (?:[2-9]|10) --generation ${UPGRADE_GEN}$`),
]);
export const upgradeToolArgvOk = args => Array.isArray(args) && args.length >= 1 && args.length <= 11 && args.every(a => typeof a === 'string' && /^[a-z0-9-]{1,64}$/.test(a))
  && UPGRADE_TOOL_ARGV.some(re => re.test(args.join(' ')));

// ---- The kernel pool alert (pool-alert.mjs, docs/architecture.md 9.1): its one fixed, read-only command ----
// The pool reader, from this generation's own resident directory (resident\<residentManifestSha256>\windows).
export const POOL_TAGS_TOOL = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'windows', 'read-pool-tags.ps1');

// Fixed argv builders. Every variable part is an id that matched a strict pattern first.
export function argv(cfg) {
  const wsl = (...linux) => [cfg.wslExe, '--distribution', cfg.distribution, '--user', 'root', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', 'LC_ALL=C', ...linux];
  const unit = (template, instance) => {
    check(/^[0-9a-f-]{1,64}(_[a-z0-9-]{1,40})?$/.test(instance), 'COMPANION_UNIT_INSTANCE_INVALID');
    return `${template}@${instance}.service`;
  };
  return {
    startWait: (template, instance) => wsl('/usr/bin/systemctl', 'start', '--wait', unit(template, instance)),
    startNoBlock: (template, instance) => wsl('/usr/bin/systemctl', 'start', '--no-block', unit(template, instance)),
    // DESIGN §26: the unit's state with the two facts that show it really ran (replaces the ActiveState-only read).
    unitFacts: (template, instance) => wsl('/usr/bin/systemctl', 'show', '--property=ActiveState,InvocationID,ExecMainStartTimestampMonotonic', unit(template, instance)),
    linuxTool: (sub, id) => { check(['quiescence'].includes(sub) && BATCH_ID.test(id), 'COMPANION_TOOL_ARGS_INVALID'); return wsl('/usr/bin/python3', '-I', '-c', LINUX_QUIESCENCE_PROBE, sub, '--batch', id); },
    archiveUsage: () => wsl(cfg.linuxTool, 'archive-usage'),
    // Task 4a: the node's own check that the Linux side is used once and thrown away (read-only; BUSY while a batch runs).
    selfcheck: () => wsl(cfg.linuxTool, 'selfcheck'),
    // DESIGN §35: one retention pass of the Linux spool (the root tool plans, re-checks and deletes; nothing variable here).
    archivePrune: () => wsl(cfg.linuxTool, 'archive-prune'),
    linuxOutgoing: () => wsl('/usr/bin/ls', '-1', '-A', '--', LINUX_OUTGOING),
    linuxIncoming: () => wsl('/usr/bin/ls', '-1', '-A', '--', LINUX_INCOMING),
    linuxRelayProcs: () => wsl('/usr/bin/pgrep', '-f', '-a', RELAY_RECORD_PROCESS),
    // DESIGN §32: the memory gate's one wsl.exe per check.
    memoryFacts: () => wsl('/usr/bin/cat', '--', ...MEMORY_FACTS_FILES),
    archiveStatus: instance => { check(/^[0-9a-f]{16}-[0-9a-f]{12}_[a-z0-9][a-z0-9-]{0,39}$/.test(instance), 'COMPANION_TOOL_ARGS_INVALID'); return wsl(cfg.linuxTool, 'archive-status', '--instance', instance); },
    relay: (mode, seq) => {
      check(['SendIssue', 'ReceiveChallenge', 'SendResponse', 'ReceiveResult', 'ReceiveBlocked'].includes(mode) && Number.isSafeInteger(seq) && seq >= 0 && seq <= 32, 'COMPANION_RELAY_ARGS_INVALID');
      return powershellArgv(cfg.powershellExe, '-File', cfg.relayScript, '-Mode', mode, '-Sequence', String(seq), '-ExpectedBundleSha256', cfg.bridgeManifestSha256, '-ExpectedNodeProfileSha256', cfg.nodeProfileSha256);
    },
    bundle: id => { check(BATCH_ID.test(id), 'COMPANION_BUNDLE_ARGS_INVALID'); return powershellArgv(cfg.powershellExe, '-File', cfg.bundleScript, '-BatchId', id); },
    checkRefs: id => { check(BATCH_ID.test(id), 'COMPANION_BUNDLE_ARGS_INVALID'); return powershellArgv(cfg.powershellExe, '-File', cfg.bundleScript, '-BatchId', id, '-CheckRefs'); },
    rebundle: id => { check(BATCH_ID.test(id), 'COMPANION_BUNDLE_ARGS_INVALID'); return powershellArgv(cfg.powershellExe, '-File', cfg.bundleScript, '-BatchId', id, '-Rebundle'); },
    keepalive: () => [cfg.wslExe, '--distribution', cfg.distribution, '--exec', '/bin/sleep', 'infinity'],
    // DESIGN §34: the frozen upgrade tool, as root, with the fixed path and arguments that pass upgradeToolArgvOk only.
    upgradeTool: args => { check(upgradeToolArgvOk(args), 'COMPANION_UPGRADE_TOOL_ARGS_INVALID'); return wsl(UPGRADE_TOOL_PATH, ...args); },
    // DESIGN §63 (Task 3ea699f6): one of the six PUBLIC live role files, base64 on one line, as root and read-only; the name is one of
    // the six fixed ones (roles-public.mjs#ROLES_PUBLIC_NAMES), nothing variable reaches the path.
    rolePublic: name => { check(ROLES_PUBLIC_NAMES.includes(name), 'COMPANION_ROLE_PUBLIC_NAME_INVALID'); return wsl('/usr/bin/base64', '-w', '0', '--', `${ROLES_PUBLIC_LINUX_DIR}/${name}`); },
    // The kernel pool alert (pool-alert.mjs): the largest paged pool tag, the paged pool and the commit charge (windows/read-pool-tags.ps1).
    poolTags: () => powershellArgv(cfg.powershellExe, '-File', POOL_TAGS_TOOL),
  };
}

const json = text => { try { return JSON.parse(text); } catch { return null; } };

// pr-head (phase 2, step 1): the PR's state and head over the Owner's own gh login, read-only, fixed argv.
export const PR_HEAD_TIMEOUT_MS = 30_000;
const PROBE_PICKUP_MS = 500;
// The service's retention requests (DESIGN §35.11): the only ones a stopping service cancels ('service-stopping'), before they start.
const RETENTION_KINDS = new Set(['archive-usage', 'archive-prune']);
// DESIGN §44 (Tasks 576231fa, 4d3aaa64, 8e1f07d3, the remainder): a wsl.exe call that ran out of time (25-45 s on a loaded host,
// DESIGN §25) says nothing about the thing it was asked, so a READ-ONLY probe, or an idempotent root-tool action, is asked again
// a bounded number of times before "no answer" is turned into a failure that HALTs. Never for an action with an effect.
export const ARCHIVE_STATUS_RESERVE_MS = 100_000; // kept free for the archive-status reads (3 x 30 s) after a second archive start
export const RETRY_MIN_ROOM_MS = 60_000; // a second attempt that would get less than this is not made
export const READ_RETRIES = 2; // reads asked again after a read that timed out: three in all
export const TERMINAL_NOANSWER_CAP_MS = 120_000; // FORMAL_WORKER_TERMINAL_UNCONFIRMED: the longest wait while the unit facts give no answer
export const WSPREP_QUIET_WAIT_MS = 5 * 60_000; // after a timed-out workspace preparation: the longest wait for the Linux side to go quiet
export const WSPREP_QUIET_POLL_MS = 20_000;
export const CHECK_REFS_SECOND_TRY_MAX_MS = 3 * 60_000; // the refs gate: a second ls-remote only when the first ended within this long
// A child that ran out of time and is gone (the job host drained its tree, or it was the plain runner's): the read has no answer.
// A tree the host could not show gone ('unconfirmed') is never asked again on top of itself.
export const timedOutGone = r => r?.timedOut === true && r.tree !== 'unconfirmed';
export function readPullArgv(ghExe, repo, pr) {
  check(typeof ghExe === 'string' && /^[A-Z]:\\/.test(ghExe) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') && Number.isSafeInteger(pr) && pr > 0 && pr < 1e9, 'COMPANION_PR_HEAD_ARGS_INVALID');
  return [ghExe, 'api', '--method', 'GET', `repos/${repo}/pulls/${pr}`, '--jq', '{number: .number, state: .state, merged: .merged, head: .head.sha, mergeSha: .merge_commit_sha, draft: .draft}'];
}
// GitHub's PR state/ref only. PR text carries no Task or claim authority.
export function parsePull(stdout, pr) {
  const v = json(stdout);
  if (!v || v.number !== pr || !['open', 'closed'].includes(v.state) || typeof v.merged !== 'boolean' || !/^[0-9a-f]{40}$/.test(v.head ?? '')) return null;
  // Advisory only: it may defer a qualification read, never authorize one.
  // Older companion answers have no mergeSha; absence is not ref movement.
  // PLAN-resident-draft-batch-20261123 §2 item 2: GitHub's draft flag, kept only as a boolean (pr-candidate.mjs judges it). An older
  // reply without it is no draft fact.
  return { number: pr, state: v.merged ? 'merged' : v.state, headSha: v.head,
    ...(typeof v.mergeSha === 'string' && /^[0-9a-f]{40}$/.test(v.mergeSha) ? { mergeSha: v.mergeSha } : {}),
    ...(typeof v.draft === 'boolean' ? { draft: v.draft } : {}) };
}

// DESIGN §24: the answer's jobTree from what the job host said about each child of one request that did not simply end
// on its own (runner.mjs `tree`): none -> null; all drained -> 'zero'; any other -> 'unconfirmed'.
export function jobTreeOf(trees) {
  if (trees.length === 0) return null;
  return trees.every(t => t === 'zero') ? 'zero' : 'unconfirmed';
}

// Bundle retention (disk/memory guard, 2026-11-15): bundles\<batchId>\ gains one repository bundle per batch and nothing removed
// them. A batch reads its bundle only while it is open, and an open batch lives at most park.maxMs (24 h, the policy's bound) after
// its bundle was built; so a batch directory whose newest entry is older than BUNDLE_KEEP_MS belongs to an ended batch and is
// removed (it is regenerable: a new batch builds its own). The BUNDLE_KEEP_NEWEST newest are always kept; only directories of the
// batch id shape directly below bundles\ are considered (the seed _seed\ and any other name never); a link anywhere in one keeps
// it; an error removes nothing more. The companion's advisory lane runs it at start and every BUNDLE_PRUNE_EVERY_MS. -> names removed.
export const BUNDLE_KEEP_MS = 30 * 3_600_000;
export const BUNDLE_PRUNE_EVERY_MS = 3_600_000;
export const BUNDLE_KEEP_NEWEST = 3;
export async function pruneBundles({ dir, now, fsImpl = fs }) {
  const newest = async (d, depth) => {
    let m = (await fsImpl.lstat(d)).mtimeMs;
    for (const e of await fsImpl.readdir(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) return Infinity;
      const p = path.join(d, e.name);
      m = Math.max(m, e.isDirectory() && depth > 0 ? await newest(p, depth - 1) : (await fsImpl.lstat(p)).mtimeMs);
    }
    return m;
  };
  const list = [];
  for (const e of await fsImpl.readdir(dir, { withFileTypes: true })) {
    if (BATCH_ID.test(e.name) && e.isDirectory() && !e.isSymbolicLink()) list.push({ name: e.name, at: await newest(path.join(dir, e.name), 2) });
  }
  list.sort((a, b) => b.at - a.at);
  const removed = [];
  for (const b of list.slice(BUNDLE_KEEP_NEWEST)) {
    if (!(now - b.at > BUNDLE_KEEP_MS)) continue;
    await fsImpl.rm(path.join(dir, b.name), { recursive: true, force: true });
    removed.push(b.name);
  }
  return removed;
}

export class Companion {
  // ports: { cfg, mailbox, run(argv,{timeoutMs}) -> {code, stdout, stderr, timedOut?, tree?}, fileExists(path), sleep(ms), clock(),
  //   readPull(pr) -> argv (pr-head; without it the companion answers PR_HEAD_UNAVAILABLE),
  //   readText(path) -> string (bounded; a SendResponse retry reads its challenge's deadline, DESIGN §25.4; without it no
  //   SendResponse retry), log(entry) (the local relay log, DESIGN §25.5; optional, its failures are swallowed),
  //   listingDelay({ quietMs, untilFactsMs, capMs }) -> ms (the pause between two listings of Linux outgoing, DESIGN §31.5; the
  //   default is listingDelayMs; a test passes () => 1000 for the one-listing-a-second pace of before) }
  constructor(ports) {
    Object.assign(this, ports);
    this.a = argv(ports.cfg);
    this.requestContext = new AsyncLocalStorage();
    this.probePasses = new Map();
    this.probeTimer = null;
    this.run = async (a, o) => {
      const context = this.requestContext.getStore();
      const r = await ports.run(a, context?.probe ? { ...o, mailboxProbe: context.probe, measureHost: true } : o);
      if (r?.tree === 'zero' || r?.tree === 'unconfirmed') context?.trees.push(r.tree);
      if (context?.probe) context.hostElapsedMs.push(r?.hostElapsedMs ?? null);
      return r;
    };
  }

  // A read-only probe: asked again (READ_RETRIES times) while it only ran out of time. An answer of any kind, a refusal, a launch
  // failure or an unconfirmed tree ends it at once; the last result is returned.
  async runRead(a, o, op = 'read', request = null) {
    let r;
    const retries = request?.previousRequestId ? 0 : READ_RETRIES;
    let last = request ? Date.parse(request.createdAt) : 0;
    for (let i = 0; i <= retries; i += 1) {
      const began = this.clock();
      if (request) {
        if (began < last) return { quiescenceCode: 'QUIESCENCE_CLOCK_REFUSED' };
        const timeoutMs = quiescenceProbeMs(Date.parse(request.deadline), began);
        if (!timeoutMs) return { quiescenceCode: 'QUIESCENCE_BUDGET_INSUFFICIENT' };
        o = { timeoutMs, measureHost: true };
      }
      r = await this.run(a, o);
      const ended = this.clock();
      if (request) {
        void this.noteQuiescence(request, 'quiescence-attempt', began, ended, {
          attempt: i + 1, timeoutMs: o.timeoutMs, elapsedMs: ended - began,
          hostElapsedMs: r?.hostElapsedMs ?? null, tree: r?.tree ?? null, timedOut: r?.timedOut === true,
        });
        last = this.clock();
        if (ended < began || last < ended) return { quiescenceCode: 'QUIESCENCE_CLOCK_REFUSED' };
        if (last > Date.parse(request.deadline)) {
          const drained = r?.timedOut === true && r.tree === 'zero' && !r.refused && r.code == null;
          return { ...r, quiescenceCode: drained ? 'QUIESCENCE_TIMEOUT_EXPIRED' : 'QUIESCENCE_RESULT_EXPIRED' };
        }
        if (r?.timedOut !== true || r.tree !== 'zero' || r.refused || r.code != null) return r;
      } else if (!timedOutGone(r)) return r;
      const logged = this.noteRetry(op, i + 1, ended - began, r);
      if (!request) await logged;
    }
    return r;
  }

  async noteQuiescence(request, kind, from, to, fields) {
    try {
      await this.log?.({ kind, requestId: request.requestId, from, to, loopDelayMs: this.loopDelay?.(from, to) ?? null, ...fields });
    } catch { /* 计时不参与静止判定 */ }
  }

  // The local log only; it never decides anything and a failing log changes nothing.
  async noteRetry(op, attempt, ms, runner) {
    try { await this.log?.(retryLogEntry({ at: this.clock() - ms, op, attempt, ms, runner })); } catch { /* the log never decides */ }
  }

  async noteBundleRefusal(op, runner) {
    try { const entry = bundleRefusalLogEntry({ at: this.clock(), op, runner }); if (entry) await this.log?.(entry); } catch { /* the log never decides */ }
  }

  async quiescence(batchId, request = null) {
    const r = await this.runRead(this.a.linuxTool('quiescence', batchId), { timeoutMs: 30_000 }, 'quiescence', request);
    const observed = r?.code === 0 && (r.timedOut === undefined || r.timedOut === false)
      && (r.refused === undefined || r.refused === null) && (r.tree === undefined || r.tree === 'zero')
      && (r.stderr === undefined || r.stderr === '');
    const v = observed ? json(r.stdout) : null;
    const valid = plainObject(v) && Object.keys(v).sort().join('|') === 'containersZero|linuxUnitsInactive|pendingJobsQuiet'
      && ['linuxUnitsInactive', 'containersZero', 'pendingJobsQuiet'].every(k => typeof v[k] === 'boolean');
    const confirmed = valid && v.pendingJobsQuiet;
    const proof = { linuxUnitsInactive: confirmed && v.linuxUnitsInactive, containersZero: confirmed && v.containersZero };
    if (!request) return proof;
    if (r?.quiescenceCode) return { ok: false, code: r.quiescenceCode, proof: valid ? proof : null };
    if (r?.refused === RUNNER_BUSY_WITH_UNFINISHED_CHILD && r.tree === 'unconfirmed') return { ok: false, code: r.refused };
    if (valid) return { ok: true, proof };
    const drained = r?.timedOut === true && r.tree === 'zero' && !r.refused && r.code == null;
    return { ok: false, code: drained ? 'QUIESCENCE_TIMEOUT' : 'QUIESCENCE_PROBE_UNCONFIRMED' };
  }

  // The bundle retention (pruneBundles), with the bundles directory of the ports (bundleDir; none: nothing). Never decides anything.
  async pruneOldBundles() {
    if (typeof this.bundleDir !== 'string') return;
    try {
      const removed = await pruneBundles({ dir: this.bundleDir, now: this.clock() });
      if (removed.length > 0) await this.log?.({ at: new Date(this.clock()).toISOString(), op: 'bundle-prune', removed: removed.length });
    } catch { /* advisory: a bundle left is only disk */ }
  }

  async handle(request) {
    switch (request.kind) {
      case 'build-bundle': {
        const r = await this.run(this.a.bundle(request.batchId), { timeoutMs: 30 * 60_000 });
        const v = r.code === 0 || r.code === 2 ? json(r.stdout) : null;
        if (r.code === 0 && v?.status === 'BUNDLE_WRITTEN') return { ok: true, code: null };
        await this.noteBundleRefusal('build-bundle', r);
        if (r.code === 2 && BUNDLE_MEMBER_MOVED_REASONS.includes(v?.reason)) return { ok: false, code: TRAIN_BATCH_MEMBER_MOVED };
        if (r.code === 2 && BUNDLE_BASE_MOVED_REASONS.includes(v?.reason)) return { ok: false, code: RESIDENT_BASE_MOVED };
        return { ok: false, code: bundleNetworkRefusal(r) ? BUNDLE_NETWORK_UNAVAILABLE : 'BUNDLE_UNAVAILABLE' };
      }
      // DESIGN §37: the second generation. Refs no longer the batch's (main moved, or no branch still at the head) is the clean
      // transient REMOTE_REFS_CHANGED_SINCE_BUNDLE; anything else (including no answer) only says the bundle could not be renewed.
      case 'rebuild-bundle': {
        const r = await this.run(this.a.rebundle(request.batchId), { timeoutMs: 30 * 60_000 });
        const v = r.code === 0 || r.code === 2 ? json(r.stdout) : null;
        if (r.code === 0 && v?.status === 'BUNDLE_WRITTEN' && v.generation === 2) return { ok: true, code: null };
        await this.noteBundleRefusal('rebuild-bundle', r);
        // Generation 13 (DESIGN §57.3): a network step that failed is said so, as for the first bundle; the executor runs it again.
        return { ok: false, code: REBUNDLE_REFS_CHANGED.includes(v?.reason) ? 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'
          : bundleNetworkRefusal(r) ? BUNDLE_NETWORK_UNAVAILABLE : 'BUNDLE_UNAVAILABLE' };
      }
      case 'prepare-workspaces': {
        const r = await this.run(this.a.startWait('clued-ci-wsprep', request.batchId), { timeoutMs: 20 * 60_000 });
        let proof = await this.quiescence(request.batchId);
        if (r.code === 0) return { ok: true, proof };
        // §44: `start --wait` ended by its time limit leaves the unit to systemd, which may still be finishing it. Only reads
        // follow (the root tool's quiescence, never a second start): quiet within the bound is the ordinary refusal (the head
        // burns, both sides are archived); a unit still busy after it stays WORKSPACE_PREPARATION_UNCONFIRMED and HALTs.
        if (timedOutGone(r) && !(proof.linuxUnitsInactive && proof.containersZero)) {
          await this.noteRetry('wsprep-quiet-wait', 1, 20 * 60_000, r);
          const until = Math.min(this.clock() + WSPREP_QUIET_WAIT_MS, Date.parse(request.deadline) - 60_000);
          while (this.clock() < until && !(proof.linuxUnitsInactive && proof.containersZero)) {
            await this.sleep(WSPREP_QUIET_POLL_MS);
            proof = await this.quiescence(request.batchId);
          }
        }
        return { ok: false, code: proof.linuxUnitsInactive ? 'WORKSPACE_PREPARATION_REFUSED' : 'WORKSPACE_PREPARATION_UNCONFIRMED', proof };
      }
      case 'archive-linux': {
        let r = await this.run(this.a.startWait('clued-ci-archive', `${request.batchId}_${request.reason}`), { timeoutMs: 5 * 60_000 });
        // §44: the archive is a rename-only root action and one instance is idempotent (the tool answers a repeated instance with the
        // earlier verified result and moves nothing, clued-ci-resident-linux#earlier_result): a `start --wait` that only ran out of
        // time is asked once more, which joins a unit still running or replays the finished one. Verified still needs exit 0 and the
        // tool's own receipt.
        // §46: only while the request's own deadline holds the second start and the status reads (ARCHIVE_LINUX_REQUEST_MS makes room
        // for both; the clamp is for a request sent with less). The service no longer waits for an answer after the deadline.
        if (timedOutGone(r)) {
          const room = Date.parse(request.deadline) - this.clock() - ARCHIVE_STATUS_RESERVE_MS;
          if (room >= RETRY_MIN_ROOM_MS) {
            const ms = Math.min(5 * 60_000, room);
            await this.noteRetry('archive-start-wait', 1, ms, r);
            r = await this.run(this.a.startWait('clued-ci-archive', `${request.batchId}_${request.reason}`), { timeoutMs: ms });
          }
        }
        const s = await this.runRead(this.a.archiveStatus(`${request.batchId}_${request.reason}`), { timeoutMs: 30_000 }, 'archive-status');
        const v = s.code === 0 ? json(s.stdout) : null;
        const verified = r.code === 0 && v?.verified === true && typeof v.directory === 'string';
        return { ok: verified, code: verified ? null : 'LINUX_ARCHIVE_UNCONFIRMED', verified, directory: verified ? v.directory : null };
      }
      case 'relay-stage': return this.pump(request);
      // Source v2 S9 / lesson b29: before the first scanner stage, the refs must still be the bundle's.
      case 'check-refs': {
        // §44: the gate is one read-only ls-remote (networkWrite false). Only a definite answer (unchanged, or changed) ends it; a read
        // that got none (git's low-speed limit, a refused proxy, a timeout) is asked once more, when the first did not take long. Reads
        // without an answer end as REMOTE_REFS_NO_ANSWER or REMOTE_REFS_UNAVAILABLE (generation 11, below).
        // Generation 11 (DESIGN 55): REMOTE_REFS_NO_ANSWER only when every read was the line and nothing else: ls-remote failed in git
        // (GIT_STEP_FAILED, ls-remote-check) or the read ran out of time with no verdict, its tree gone ('zero', never 'unconfirmed'). Any
        // other refusal of the script (a descriptor, a generation) stays REMOTE_REFS_UNAVAILABLE, which the engine never asks again.
        let v = null, r = null, room = 5 * 60_000, line = true;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const began = this.clock();
          r = await this.run(this.a.checkRefs(request.batchId), { timeoutMs: room });
          v = json(r.stdout);
          const gitLine = v?.reason === 'GIT_STEP_FAILED' && v?.git?.label === 'ls-remote-check';
          const silent = !v?.status && !v?.reason && r.timedOut === true && r.tree === 'zero' && !r.refused;
          if (r.tree === 'unconfirmed' || !(gitLine || silent)) line = false;
          if ((r.code === 0 && v?.status === 'REMOTE_REFS_UNCHANGED') || v?.status === 'REMOTE_REFS_CHANGED_SINCE_BUNDLE') break;
          if (r.tree === 'unconfirmed' || this.clock() - began > CHECK_REFS_SECOND_TRY_MAX_MS) break;
          // §46: the second try gets what is left of the request's deadline (CHECK_REFS_REQUEST_MS makes room for a full one), and
          // none when too little is left.
          room = Math.min(5 * 60_000, Date.parse(request.deadline) - this.clock() - 10_000);
          if (room < RETRY_MIN_ROOM_MS) break;
          await this.noteRetry('check-refs', attempt, this.clock() - began, r);
        }
        if (r.code === 0 && v?.status === 'REMOTE_REFS_UNCHANGED') return { ok: true, code: null };
        if (v?.status === 'REMOTE_REFS_CHANGED_SINCE_BUNDLE') return { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' };
        return { ok: false, code: line ? 'REMOTE_REFS_NO_ANSWER' : 'REMOTE_REFS_UNAVAILABLE' };
      }
      case 'archive-usage': {
        const r = await this.run(this.a.archiveUsage(), { timeoutMs: 2 * 60_000 });
        const v = r.code === 0 ? json(r.stdout) : null;
        const ok = v?.contract === 'clued.independent-ci.linux-archive-usage/1' && Number.isSafeInteger(v.bytes) && v.bytes >= 0 && Number.isSafeInteger(v.directories) && v.directories >= 0;
        return ok ? { ok: true, usage: { bytes: v.bytes, directories: v.directories } } : { ok: false, code: 'LINUX_ARCHIVE_USAGE_UNCONFIRMED' };
      }
      // DESIGN §35: the root tool's facts of one retention pass, carried as they are (exact shape) with the usage after it. A
      // refused pass (exit 1 with the tool's own facts) is carried too: the service records why nothing was deleted.
      case 'archive-prune': {
        const r = await this.run(this.a.archivePrune(), { timeoutMs: 9 * 60_000 });
        const v = 'tree' in r ? null : json(r.stdout);
        let prune = null;
        try { prune = v?.contract === 'clued.independent-ci.linux-archive-prune/1' ? validatePrune(v.prune) : null; } catch { prune = null; }
        const usage = v?.usage && Number.isSafeInteger(v.usage.bytes) && v.usage.bytes >= 0 && Number.isSafeInteger(v.usage.directories) && v.usage.directories >= 0
          ? { bytes: v.usage.bytes, directories: v.usage.directories } : null;
        if (!prune) return { ok: false, code: 'LINUX_ARCHIVE_PRUNE_UNCONFIRMED' };
        return r.code === 0 && prune.refused === null && prune.stopped === null ? { ok: true, prune, usage } : { ok: false, code: prune.refused ?? prune.stopped?.code ?? 'LINUX_ARCHIVE_PRUNE_UNCONFIRMED', prune, usage };
      }
      // Verbatim root-tool facts; the companion never synthesises a proof value itself.
      case 'linux-quiescence':
        if (!await this.mailbox.claimProbe(request)) {
          return { ok: false, code: 'QUIESCENCE_PROBE_UNCONFIRMED' };
        }
        if (request.previousRequestId && !await this.mailbox.predecessorAllowsProbe(request)) {
          return { ok: false, code: 'QUIESCENCE_PREDECESSOR_UNCONFIRMED' };
        }
        return this.quiescence(request.batchId, request);
      // DESIGN §32: the facts only (ring order, free blocks of at least that order); the service applies its threshold.
      case 'memory-ready': {
        const r = await this.run(this.a.memoryFacts(), { timeoutMs: RELAY_CHECK_TIMEOUT_MS });
        const memory = r.code === 0 && !('tree' in r) ? parseMemoryFacts(r.stdout) : null;
        return memory ? { ok: true, memory } : { ok: false, code: 'LINUX_MEMORY_UNREADABLE' };
      }
      case 'pr-head': {
        if (typeof this.readPull !== 'function') return { ok: false, code: 'PR_HEAD_UNAVAILABLE' };
        const began = this.clock();
        const timeoutMs = Math.min(PR_HEAD_TIMEOUT_MS, Date.parse(request.deadline) - began - PROBE_DELIVERY_MS - PR_HEAD_JOB_HOST_GRACE_MS);
        if (began < Date.parse(request.createdAt) || timeoutMs < JOB_HOST_MIN_TIMEOUT_MS) {
          return { ok: false, code: 'PR_HEAD_BUDGET_INSUFFICIENT' };
        }
        const r = await this.run(this.readPull(request.pr), { timeoutMs });
        const ended = this.clock();
        const exitFailed = Number.isInteger(r.code) && r.code !== 0;
        if (exitFailed) {
          const stderr = String(r.stderr ?? '').replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '<token>');
          try {
            await this.log?.({ at: new Date(ended).toISOString(), kind: 'pr-head', pr: request.pr,
              exitCode: r.code, stderrTail: stderrTail(stderr).slice(-300) });
          } catch { /* the log never decides */ }
        }
        if (r.timedOut) return { ok: false, code: 'PR_HEAD_TIMED_OUT' };
        if (r.refused || r.tree === 'unconfirmed') return { ok: false, code: 'PR_HEAD_TREE_UNCONFIRMED' };
        if (exitFailed) return { ok: false, code: 'PR_HEAD_GH_FAILED' };
        const pull = ended >= began && ended <= Date.parse(request.deadline) && r.code === 0 ? parsePull(r.stdout, request.pr) : null;
        return pull ? { ok: true, pull } : { ok: false, code: 'PR_HEAD_UNAVAILABLE' };
      }
      default: return { ok: false, code: 'COMPANION_REQUEST_KIND_REFUSED' };
    }
  }

  // relay (DESIGN §25): true = record transferred, false = nothing there yet. A refusal throws RELAY_REFUSED_NO_RETRY, or
  // RELAY_PARTIAL_RECORD_PRESERVED for half a record; `permanent` is false only when retries or their budget ran out.
  // budget: { live (the pump's cancel check, before every attempt), deadline (stage), firstSeen (ReceiveChallenge),
  // challengeDeadline() (SendResponse) }. Without a budget an attempt is never repeated.
  async relay(mode, seq, budget = {}) {
    const gaps = RELAY_ATTEMPTS[mode] ?? [], name = relayRecordName(mode, seq);
    const refuse = (code, permanent) => { throw Object.assign(new Error(code), { code, permanent }); };
    let noChildRetried = false;
    for (let attempt = 1; ; attempt += 1) {
      if (budget.live) await budget.live();
      const started = this.clock();
      const r = await this.run(this.a.relay(mode, seq), { timeoutMs: RELAY_TIMEOUT_MS });
      const v = json(r.stdout);
      const klass = classifyRelayAttempt(r, v);
      try { await this.log?.(relayLogEntry({ at: started, mode, seq, attempt, ms: this.clock() - started, runner: r, receipt: v, klass })); } catch { /* the log never decides */ }
      if (klass === 'OK') return true;
      if (klass === 'NOT_YET') return false;
      if (klass === 'PERMANENT') refuse('RELAY_REFUSED_NO_RETRY', true);
      if (klass === 'NO_CHILD') {
        if (noChildRetried) refuse('RELAY_REFUSED_NO_RETRY', false); // once: it may be lasting (spool IO, an ACL)
        noChildRetried = true;
      } else {
        // CHILD_FAILED, AMBIGUOUS, EXISTING: settled by the target itself. A Send* first waits for its Linux writer to be gone
        // (a CHILD_FAILED one before looking, an AMBIGUOUS one before trying again); a check that fails settles nothing.
        if (klass === 'CHILD_FAILED' && relaySends(mode) && await this.linuxRelayIdle() !== true) refuse('RELAY_REFUSED_NO_RETRY', true);
        const where = await this.arrived(mode, name);
        if (where === 'arrived') return true;
        if (where === 'partial') refuse('RELAY_PARTIAL_RECORD_PRESERVED', true);
        if (where !== 'none' || klass === 'EXISTING') refuse('RELAY_REFUSED_NO_RETRY', true);
        if (klass === 'AMBIGUOUS' && relaySends(mode) && await this.linuxRelayIdle() !== true) refuse('RELAY_REFUSED_NO_RETRY', true);
      }
      if (attempt > gaps.length) refuse('RELAY_REFUSED_NO_RETRY', false);
      await this.sleep(gaps[attempt - 1]);
      if (!(await this.relayBudgetHolds(mode, budget))) refuse('RELAY_REFUSED_NO_RETRY', false);
    }
  }

  // Whether another attempt may start now (DESIGN §25.4).
  async relayBudgetHolds(mode, budget) {
    const now = this.clock();
    // Never past the stage's own deadline: the service no longer waits for this answer then.
    if (Number.isFinite(budget.deadline) && now >= budget.deadline) return false;
    if (mode === 'ReceiveChallenge') return Number.isFinite(budget.firstSeen) && now <= budget.firstSeen + CALLBACK_WINDOW_MS - CHALLENGE_RESERVE_MS;
    if (mode === 'SendResponse') {
      const end = typeof budget.challengeDeadline === 'function' ? await budget.challengeDeadline() : null;
      return Number.isFinite(end) && now <= end - RESPONSE_RESERVE_MS;
    }
    return Number.isFinite(budget.deadline) && budget.deadline - now >= STAGE_RESERVE_MS;
  }

  // Did the record reach its target (DESIGN §25.3)? Both ends only create, data first and its ready marker last, and a name
  // is used once per stage. 'arrived' = both, 'none' = neither, 'partial' = anything else, null = could not tell.
  async arrived(mode, name) {
    let data, ready;
    if (relaySends(mode)) {
      const r = await this.run(this.a.linuxIncoming(), { timeoutMs: RELAY_CHECK_TIMEOUT_MS });
      if (r.code !== 0 || 'tree' in r) return null;
      const names = new Set(String(r.stdout).split(/\r?\n/).map(s => s.trim()));
      [data, ready] = [names.has(`${name}.json`), names.has(`${name}.ready.json`)];
    } else {
      const dir = `${this.cfg.windowsSpool}\\incoming`;
      try { [data, ready] = [await this.fileExists(`${dir}\\${name}.json`), await this.fileExists(`${dir}\\${name}.ready.json`)]; } catch { return null; }
    }
    return data && ready ? 'arrived' : !data && !ready ? 'none' : 'partial';
  }

  // No Linux relay-record.mjs left running (DESIGN §25.3): the job host ended Windows' powershell and wsl.exe, but nothing
  // shows the Linux end went with them. pgrep exit 1 = none; exit 0 = look once more after 2 s; anything else = not idle.
  async linuxRelayIdle() {
    for (let look = 1; look <= 2; look += 1) {
      if (look === 2) await this.sleep(2000);
      const r = await this.run(this.a.linuxRelayProcs(), { timeoutMs: RELAY_CHECK_TIMEOUT_MS });
      if (r.code === 1 && !('tree' in r)) return true;
      if (r.code !== 0) return false;
    }
    return false;
  }

  // A SendResponse retry's budget: the deadline field of the challenge it answers, read from that record in Windows incoming
  // (public bytes, only this field, only to decide whether to try again). null = no retry.
  async challengeDeadline(seq) {
    if (typeof this.readText !== 'function') return null;
    try {
      const t = Date.parse(json(await this.readText(`${this.cfg.windowsSpool}\\incoming\\${relayRecordName('ReceiveChallenge', seq)}.json`))?.deadline);
      return Number.isFinite(t) ? t : null;
    } catch { return null; }
  }

  // The names of the complete Linux outgoing records (their ready markers), from one root `ls` (about
  // 0.15 s, where a relay call that finds nothing takes about 5 s). Only a hint for when to call the relay:
  // the relay stays the only transfer and re-validates every record. null = the listing failed.
  async linuxReady() {
    const r = await this.run(this.a.linuxOutgoing(), { timeoutMs: 15_000 });
    if (r.code !== 0) return null;
    return new Set(String(r.stdout).split(/\r?\n/).map(s => s.trim()).filter(s => s.endsWith('.ready.json')));
  }

  // After a failed callback round (the issuer was late, or the worker gave up before the response arrived)
  // the Linux worker ends with its clean 'blocked' record (BRIDGE_CALLBACK_DEADLINE) while the Windows issuer
  // still waits for a record. Hand exactly that record over, once, so the issuer ends BLOCKED now instead of
  // UNCERTAIN at its own deadline. Never a result; a refused ReceiveBlocked is never tried again. Without a
  // listing the relay itself is the probe (false = not there yet). The hand-over is a wait step like any other:
  // `live` throws COMPANION_PUMP_CANCELLED once the service cancelled the pump (Owner abort).
  async handOverBlocked(deadline, live = async () => {}) {
    const began = this.clock();
    const until = Math.min(deadline, began + CALLBACK_WINDOW_MS + 30_000);
    while (this.clock() < until) {
      await live();
      const names = await this.linuxReady();
      if (names === null || names.has('blocked.ready.json')) { try { if (await this.relay('ReceiveBlocked', 0, { live, deadline })) return true; } catch (e) { if (e?.code === 'COMPANION_PUMP_CANCELLED') throw e; return false; } }
      await this.sleep(this.paceListing({ quietMs: this.clock() - began, capMs: HANDOVER_LISTING_CAP_MS }));
    }
    return false;
  }

  // The pause before the next listing of Linux outgoing (DESIGN §31.5): quietMs since anything happened, untilFactsMs to the next
  // read of the worker's unit facts (a pause never runs past it, so those reads keep WORKER_FACTS_EVERY_MS), capMs the longest pause.
  paceListing({ quietMs, untilFactsMs = Infinity, capMs = LISTING_CAP_MS }) {
    if (typeof this.listingDelay === 'function') return this.listingDelay({ quietMs, untilFactsMs, capMs });
    return Math.max(100, Math.min(listingDelayMs(quietMs, capMs), untilFactsMs));
  }

  // The bridge pump that run-batch.ps1 performs today (lines 86-89), moved out of the elevated
  // process unchanged in meaning: issue -> worker -> challenge/response rounds -> result.
  // Owner abort (DESIGN §6.5): a cancel of this request from the service ends the pump at its next wait step with
  // COMPANION_PUMP_CANCELLED. No relay call starts after it; one already running ends first (at most RELAY_TIMEOUT_MS). It only
  // stops relaying; the worker unit is never stopped or killed. A cancel file that cannot be read is no cancel.
  async pump(request) {
    const deadline = Date.parse(request.deadline);
    const spool = this.cfg.windowsSpool;
    const ready = name => this.fileExists(`${spool}\\outgoing\\${name}.ready.json`);
    // Without a listing, every record is "maybe there" and the relay itself is the probe (the v1 way).
    const listed = (names, name) => names === null || names.has(`${name}.ready.json`);
    const cancelled = async () => { try { return await this.mailbox.cancelled(request); } catch { return false; } };
    const live = async () => { check(!(await cancelled()), 'COMPANION_PUMP_CANCELLED'); };
    // Every relay call checks the cancel before each of its attempts and retries only within its budget (DESIGN §25.4).
    // Stage timings (status /8): each relay call that carried a record, and each admission challenge round (challenge taken -> response sent).
    const timing = { handoffs: [], rounds: [] };
    const relay = async (mode, seq, budget = {}) => {
      const from = this.clock();
      const done = await this.relay(mode, seq, { live, ...budget });
      if (done && timing.handoffs.length < 400) timing.handoffs.push({ mode, seq, ms: Math.max(0, this.clock() - from) });
      return done;
    };
    try {
      // A request cancelled before its pump began (a companion restarted after the service gave its heartbeat up, DESIGN §26)
      // never starts one: it answers COMPANION_PUMP_CANCELLED.
      await live();
      // One pump per request (r3 implementation review MINOR 1): a companion restarted while this request's pump ran (before
      // any cancel) finds that pump's mark and starts no second one; the service reads the answer as a dead pump (signal A).
      let first = false;
      try { first = await this.mailbox.claimPump(request); } catch { first = false; }
      check(first === true, 'COMPANION_PUMP_UNCONFIRMED');
      while (!(await ready('issue'))) { check(this.clock() < deadline, 'ACTUAL_ISSUE_NOT_PUBLISHED'); await live(); await this.sleep(100); }
      check(await relay('SendIssue', 0, { deadline }), 'ISSUE_TRANSFER_UNCONFIRMED');
      // DESIGN 54: before a run again starts the instance a second time, its facts from the run before are the baseline.
      let baseline = null;
      if (request.again) baseline = parseUnitFacts(await this.runRead(this.a.unitFacts('clued-ci-worker', request.jobId), { timeoutMs: RELAY_CHECK_TIMEOUT_MS }, 'worker-unit-baseline')) ?? 'unread';
      const ranSince = f => workerRanSince(f, baseline);
      await live(); // a cancel that came with the issue transfer starts no worker
      const startCalledAt = this.clock(); // no challenge can exist before the worker was asked to start
      let start = await this.run(this.a.startNoBlock('clued-ci-worker', request.jobId), { timeoutMs: 30_000 });
      // §44: a start that only ran out of time is never repeated (a second start of an instance that already ran would run the
      // worker again). Only the unit's own facts decide: evidence that this instance has run (the instance carries this job's id
      // and only this pump starts it) makes the start a success; none leaves LINUX_WORKER_START_UNCONFIRMED as before.
      if (start.code !== 0 && timedOutGone(start)) {
        await this.noteRetry('worker-start', 1, 30_000, start);
        const f = parseUnitFacts(await this.runRead(this.a.unitFacts('clued-ci-worker', request.jobId), { timeoutMs: RELAY_CHECK_TIMEOUT_MS }, 'worker-unit-facts'));
        if (ranSince(f)) start = { code: 0 };
      }
      check(start.code === 0, 'LINUX_WORKER_START_UNCONFIRMED');
      let sequence = 1, blockedRefused = false;
      // Signals B and C (DESIGN §26). The pump remembers that the worker ran (a unit reaped after its end reads empty), and
      // whether Linux outgoing ever listed a record (then it did run, whatever its unit says: never "not started").
      const startedAt = this.clock();
      const worker = { ran: false, ended: false, listedRecord: false, factsAt: startedAt };
      const observeWorker = async () => {
        if (this.clock() < worker.factsAt) return;
        worker.factsAt = this.clock() + WORKER_FACTS_EVERY_MS;
        const f = parseUnitFacts(await this.run(this.a.unitFacts('clued-ci-worker', request.jobId), { timeoutMs: RELAY_CHECK_TIMEOUT_MS }));
        if (ranSince(f) || sequence > 1) worker.ran = true;
        // Ended: it ran, and its unit is inactive or failed now. The listing the loop takes next is then final: nobody writes
        // Linux outgoing once the worker is gone.
        worker.ended = worker.ran && !!f && ['inactive', 'failed'].includes(f.activeState);
        // Signal C only on a fact actually read (a failed read shows nothing either way) and never once a record was listed.
        check(!f || worker.ran || worker.listedRecord || this.clock() - startedAt < WORKER_START_WAIT_MS, 'LINUX_WORKER_NOT_STARTED');
      };
      const RECORD = /^(challenge-[0-9]{2}|result|blocked)\.ready\.json$/;
      // The ReceiveChallenge retry budget counts from an anchor that is never later than the challenge's creation (DESIGN §31.5):
      // `lowerBound` = the latest moment the challenge certainly did not exist yet. That is the start of the last successful
      // listing that did not show it; after a response, the moment its transfer began (challenge k+1 is made only after the
      // worker has the response k); before any of these, the moment the worker was asked to start. A challenge is stored at its
      // first sighting in a listing. A listing that failed shows nothing, so the bound stands: the relay call is the probe and
      // the budget is no later than a listing would have given it (review of §31, MAJOR-2).
      const firstSeen = new Map();
      const seenAt = (names, seq, anchor) => { if (firstSeen.has(seq)) return firstSeen.get(seq); if (names !== null) firstSeen.set(seq, anchor); return anchor; };
      // Pace of the listing (DESIGN §31.5): what has happened last (the start, a changed listing, a relayed record).
      let eventAt = startedAt, lowerBound = startCalledAt, previousNames = null, hotUntil = -Infinity;
      // A ReceiveBlocked refused for good is remembered (never tried twice); one that only found nothing, or ran out of
      // retries, is not.
      const receiveBlocked = async () => { try { return await relay('ReceiveBlocked', 0, { deadline }); } catch (e) { if (e?.permanent) blockedRefused = true; throw e; } };
      try {
        for (;;) {
          check(this.clock() < deadline, 'FORMAL_BRIDGE_STAGE_DEADLINE');
          await live();
          await observeWorker();
          const listingAt = this.clock();
          const names = await this.linuxReady();
          const anchor = lowerBound;
          if (names !== null) {
            lowerBound = Math.max(lowerBound, listingAt);
            const signature = [...names].sort().join('|');
            if (previousNames !== null && signature !== previousNames) eventAt = this.clock();
            previousNames = signature;
          }
          if (names && [...names].some(n => RECORD.test(n))) worker.listedRecord = true;
          // The worker's clean refusal (bridge v4 'blocked') means it has ended: it goes before a stale challenge.
          if (names?.has('blocked.ready.json') && await receiveBlocked()) break;
          // Then a challenge: a callback has a deadline (CALLBACK_WINDOW_MS), the result does not hurry.
          const challenge = relayRecordName('ReceiveChallenge', sequence);
          if (sequence <= 32 && listed(names, challenge)) {
            const roundFrom = this.clock();
            if (await relay('ReceiveChallenge', sequence, { deadline, firstSeen: seenAt(names, sequence, anchor) })) {
              eventAt = this.clock();
              const responseDeadline = this.clock() + CALLBACK_WINDOW_MS;
              const name = relayRecordName('SendResponse', sequence), seq = sequence;
              while (!(await ready(name))) { check(this.clock() < responseDeadline, 'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED'); await live(); await this.sleep(100); }
              const sendingAt = this.clock();
              check(await relay('SendResponse', seq, { deadline, challengeDeadline: () => this.challengeDeadline(seq) }), 'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED');
              timing.rounds.push({ seq, ms: Math.max(0, this.clock() - roundFrom) });
              // The worker makes challenge k+1 only after it has response k, which cannot be before this transfer began; the
              // listing taken before the round (even one that already ran long) says nothing about the next challenge (MAJOR-1).
              lowerBound = Math.max(lowerBound, sendingAt);
              sequence += 1;
              eventAt = this.clock();
              hotUntil = eventAt + HOT_WINDOW_MS;
              continue;
            }
          }
          if (listed(names, 'result') && await relay('ReceiveResult', 0, { deadline })) break;
          if (names === null && await receiveBlocked()) break;
          // Signal B: the worker ran and ended, and the listing taken after that holds no blocked record, no result and no
          // challenge still to relay. Without a listing nothing is final.
          if (worker.ended && names !== null && !names.has('blocked.ready.json') && !names.has('result.ready.json') && !(sequence <= 32 && names.has(`${challenge}.ready.json`))) {
            fail('LINUX_WORKER_ENDED_WITHOUT_RECORD');
          }
          // Every second right after anything happened, then less and less often (DESIGN §31.5): a listing is a wsl.exe start.
          await this.sleep(names === null ? 100 : this.paceListing({ quietMs: this.clock() - eventAt, untilFactsMs: worker.factsAt - this.clock(), capMs: this.clock() < hotUntil ? HOT_LISTING_CAP_MS : LISTING_CAP_MS }));
        }
      } catch (error) {
        // An Owner abort stops the Windows issuer anyway: no blocked hand-over (it checks the cancel before each of its
        // steps), and the outer catch answers COMPANION_PUMP_CANCELLED. Signals B and C need none either: the final listing
        // held no blocked record, or the worker never ran (DESIGN §26).
        if (!blockedRefused && !['COMPANION_PUMP_CANCELLED', 'LINUX_WORKER_ENDED_WITHOUT_RECORD', 'LINUX_WORKER_NOT_STARTED'].includes(error?.code)) await this.handOverBlocked(deadline, live);
        throw error;
      }
      const until = this.clock() + 30_000, hardUntil = this.clock() + TERMINAL_NOANSWER_CAP_MS;
      for (let look = 0; ; look += 1) {
        const s = parseUnitFacts(await this.run(this.a.unitFacts('clued-ci-worker', request.jobId), { timeoutMs: 15_000 }));
        if (s && ['inactive', 'failed'].includes(s.activeState)) break;
        // §44: the 30 s are for a unit that was read and is still busy; while the reads themselves get no answer (a loaded wsl.exe
        // takes 25-45 s, so two reads fit in 30 s) the wait goes on, but no longer than TERMINAL_NOANSWER_CAP_MS in all.
        check(this.clock() < (s ? until : hardUntil), 'FORMAL_WORKER_TERMINAL_UNCONFIRMED');
        await live();
        await this.sleep(Math.min(2000, 500 * 2 ** look)); // 0.5, 1, 2 s, then every 2 s: at most about 17 reads in the 30 s, not 60
      }
      return { ok: true, proof: await this.quiescence(request.batchId) };
    } catch (error) {
      // Never stop or kill the worker: report what is known and let the service classify. A cancelled pump answers
      // COMPANION_PUMP_CANCELLED whatever step it ended in, also a relay call that failed as the cancel came.
      const code = (await cancelled()) ? 'COMPANION_PUMP_CANCELLED' : /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code ?? '') ? error.code : 'COMPANION_PUMP_UNCONFIRMED';
      return { ok: false, code, proof: await this.quiescence(request.batchId) };
    } finally {
      // Before the answer is written, so the service finds the record when it reads the answer. A view: never an error out of the pump.
      if (timing.handoffs.length > 0 && typeof this.mailbox.writeTiming === 'function') { try { await this.mailbox.writeTiming(request, timing); } catch { /* the stage's time is still measured by the service */ } }
    }
  }

  async respondTo(request) {
    const probe = PROBE_KINDS.includes(request.kind) ? request.kind : null;
    const context = { probe, trees: [], hostElapsedMs: [] };
    const enqueuedAt = Date.parse(request.createdAt), pickedUpAt = this.clock();
    const dispatch = probe ? { enqueuedAt, pickedUpAt, handlerStartedAt: null, handlerEndedAt: null,
      hostElapsedMs: context.hostElapsedMs } : null;
    if (probe === 'linux-quiescence') {
      void this.noteQuiescence(request, 'quiescence-start', enqueuedAt, pickedUpAt, { queueMs: pickedUpAt - enqueuedAt });
    }
    if (pickedUpAt >= Date.parse(request.deadline)) {
      const interrupted = probe === 'linux-quiescence' && await this.mailbox.probeClaimed(request);
      await this.mailbox.respond(request, { ok: false, code: interrupted ? 'QUIESCENCE_PROBE_UNCONFIRMED' : 'COMPANION_REQUEST_EXPIRED' }, dispatch);
      return;
    }
    // 跳过服务已取消且尚未启动的保留任务。运行中的处理器按原生命周期收尾。
    if (RETENTION_KINDS.has(request.kind) && (await this.mailbox.cancelled(request).catch(() => false))) {
      await this.mailbox.respond(request, { ok: false, code: 'COMPANION_REQUEST_CANCELLED' });
      return;
    }
    if (dispatch) dispatch.handlerStartedAt = this.clock();
    let answer;
    try { answer = await this.requestContext.run(context, () => this.handle(request)); }
    catch { answer = { ok: false, code: 'COMPANION_HANDLER_UNCONFIRMED' }; }
    if (dispatch) dispatch.handlerEndedAt = this.clock();
    await this.mailbox.respond(request, { ok: answer.ok === true, code: answer.ok ? null : (answer.code ?? 'COMPANION_HANDLER_UNCONFIRMED'), proof: answer.proof ?? null, directory: answer.directory ?? null, verified: answer.verified ?? null, usage: answer.usage ?? null, pull: answer.pull ?? null,
      jobTree: jobTreeOf(context.trees), memory: answer.memory ?? null, prune: answer.prune ?? null }, dispatch);
  }

  takeProbes(kind, legacy = null) {
    const active = this.probePasses.get(kind);
    if (active) return legacy ? active.then(() => this.takeProbes(kind, legacy)) : active;
    const pass = (async () => {
      const requests = legacy ? [legacy] : await this.mailbox.pendingProbe(kind);
      for (const request of requests) {
        try {
          if (legacy && await this.mailbox.poll(request)) continue;
          await this.respondTo(request);
        } catch { /* 本封缺答，其余请求继续按各自截止时间处理。 */ }
      }
    })().catch(() => {}).finally(() => this.probePasses.delete(kind));
    this.probePasses.set(kind, pass);
    return pass;
  }

  step() {
    if (!this.primaryPass) this.primaryPass = this.stepMailbox().finally(() => { this.primaryPass = null; });
    return this.primaryPass;
  }

  startProbeLane() {
    if (this.probeTimer !== null || typeof this.mailbox.pendingProbe !== 'function') return;
    // 主通道的处理器或 Job Host 仍忙时，两个探针照常取件。
    this.probeTimer = setInterval(() => PROBE_KINDS.map(kind => this.takeProbes(kind)), PROBE_PICKUP_MS).unref();
  }

  stopProbeLane() {
    if (this.probeTimer === null) return;
    clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  async stepMailbox() {
    const indexed = typeof this.mailbox.pendingProbe === 'function';
    const probes = indexed ? PROBE_KINDS.map(kind => this.takeProbes(kind)) : [];
    try {
      try { await this.mailbox.beat(); } catch { /* a liveness hint only */ }
      for (const request of await this.mailbox.pending()) {
        if (request.refused) continue;
        if (indexed && PROBE_KINDS.includes(request.kind)) {
          // 接续旧版服务已发出但没有取件索引的请求。
          if (!await this.mailbox.probeQueued(request)) await this.takeProbes(request.kind, request);
        } else {
          await this.respondTo(request);
        }
      }
    } finally {
      await Promise.all(probes);
    }
  }
}

// ---- the upgrade mailbox lane (in-place upgrade channel, Task 018da927, DESIGN §34) ----
//
// A lane of its own (companion-main.mjs): upgrade\mailbox\requests\ (written by the upgrader, SYSTEM) is read here, each request is
// carried to the frozen root tool with the fixed argv above, and the tool's one line of JSON goes back as is into
// upgrade\mailbox\responses\ (upgrade-mailbox.mjs#responseFromTool, protocol frozen at /1: every later companion answers /1 exactly
// so). Besides, the Linux version facts are rewritten whole into responses\version-facts.json every VERSION_FACTS_REFRESH_MS and at
// once after every switch or rollback (whatever its answer), so the resident's status /7 and its version-skew hold read fresh facts.
// A request whose deadline has passed is never run (its upgrader may already have concluded "no answer"): it is answered as refused.
// A request the lane cannot read is left alone (its upgrader times out). Nothing here decides anything: the upgrader and the root
// tool re-check what they are given.
export const UPGRADE_REQUEST_EXPIRED = 'UPGRADE_MAILBOX_REQUEST_EXPIRED';
// A facts read that failed is tried again this soon (not every lane pass).
export const VERSION_FACTS_RETRY_MS = 60_000;
export class UpgradeLane {
  // ports: { cfg, mailbox (upgrade-mailbox.mjs#UpgradeMailbox, or openMailbox() -> one, tried again each pass until it opens: a node
  //   without the channel's directories runs the companion as before), run(argv, { timeoutMs }) -> { code, stdout, timedOut? },
  //   clock() }
  constructor(ports) {
    Object.assign(this, ports);
    this.a = argv(ports.cfg);
    this.factsAt = null;       // the last facts written (lane clock)
    this.factsTriedAt = null;  // the last facts read tried
    this.factsDue = true;
    this.selfcheckAt = null;       // the last answer that was a result (lane clock)
    this.selfcheckTriedAt = null;  // the last run tried (a BUSY or failed run is tried again after SELFCHECK_BUSY_RETRY_MS)
  }

  async box() {
    if (this.mailbox) return this.mailbox;
    if (typeof this.openMailbox !== 'function') return null;
    try { this.mailbox = await this.openMailbox(); } catch { this.mailbox = null; }
    return this.mailbox;
  }

  // One run of the root tool for a request (or the lane's own facts read): { exit, stdout } as responseFromTool takes it. A child
  // that timed out or could not start is exit -1 / null: never success.
  async tool(request, timeoutMs) {
    const r = await this.run(this.a.upgradeTool(upgradeToolArgs(request)), { timeoutMs: Math.max(1000, timeoutMs) });
    return { exit: r?.timedOut ? -1 : (Number.isSafeInteger(r?.code) ? r.code : null), stdout: typeof r?.stdout === 'string' ? r.stdout : '' };
  }

  // The facts, read now and written whole; true when written.
  async refreshFacts(box) {
    const now = this.clock();
    this.factsTriedAt = now;
    let request, response;
    try { request = upgradeMailboxRequest({ kind: 'linux-version-facts' }, this.clock); } catch { return false; }
    try { response = responseFromTool(request, await this.tool(request, UPGRADE_TIMEOUT_MS['linux-version-facts']), this.clock); } catch { return false; }
    if (!response.ok) return false;
    try { validateVersionFacts(response.result); await box.writeVersionFacts(response.result); } catch { return false; }
    this.factsAt = this.clock();
    this.factsDue = false;
    await this.refreshRolesPublic(box, response.result);
    return true;
  }

  // DESIGN §63 (Task 3ea699f6): right after facts are written, the public copy of the six live role files in
  // responses\roles-public.json, when the copy there is not the one these facts name (in practice once per generation: the first
  // facts after a switch or rollback, or the new companion's first facts). Each file is read with the fixed argv rolePublic and
  // taken only when its bytes hash to these facts; the first failure leaves the copy as it was (the next facts try again). Facts
  // that do not name all six files, or a mailbox without a responses directory, copy nothing. Never throws; the outcome is kept in
  // this.rolesPublic for logs and tests: 'current' | 'written' | 'skipped' | 'failed'.
  async refreshRolesPublic(box, facts) {
    try {
      const want = rolesPublicWanted(facts);
      if (!want || typeof box?.responses !== 'string') return (this.rolesPublic = 'skipped');
      if (rolesPublicCurrent(await readRolesPublic(box.responses), facts)) return (this.rolesPublic = 'current');
      const files = {};
      for (const name of ROLES_PUBLIC_NAMES) {
        const r = await this.run(this.a.rolePublic(name), { timeoutMs: ROLES_PUBLIC_TIMEOUT_MS });
        const bytes = r && r.code === 0 && !r.timedOut && !r.refused ? rolePublicBytes(r.stdout, want[name]) : null;
        if (!bytes) return (this.rolesPublic = 'failed');
        files[name] = bytes;
      }
      await writeRolesPublic(box.responses, rolesPublicDocument(facts, files, this.clock()));
      return (this.rolesPublic = 'written');
    } catch {
      return (this.rolesPublic = 'failed');
    }
  }

  // Task 4a: the node's self-check, run by the root tool between batches and kept whole in responses\selfcheck.json (selfcheck.mjs). A run that
  // is BUSY, refused, timed out or unreadable writes nothing (the file keeps the last result and its age shows it as STALE): a helper that
  // cannot run does nothing and never stops the lane. Returns true when a result was written.
  async refreshSelfcheck(box) {
    this.selfcheckTriedAt = this.clock();
    try {
      if (typeof box?.responses !== 'string') return false;
      const r = await this.run(this.a.selfcheck(), { timeoutMs: SELFCHECK_TIMEOUT_MS });
      if (!r || r.code !== 0 || r.timedOut || r.refused || typeof r.stdout !== 'string') return false;
      let tool;
      try { tool = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)); } catch { return false; }
      const doc = selfcheckDocument(tool, this.clock());
      if (!doc) return false;
      await writeSelfcheck(box.responses, doc);
      this.selfcheckAt = this.clock();
      return true;
    } catch { return false; }
  }

  // Its own pass after step() (companion-main.mjs): due when never written or older than SELFCHECK_REFRESH_MS; a run that wrote nothing is
  // tried again after SELFCHECK_BUSY_RETRY_MS. Never throws.
  async selfcheckStep() {
    try {
      if (!this.selfcheckWanted(this.clock())) return false;
      const box = await this.box();
      return box ? await this.refreshSelfcheck(box) : false;
    } catch { return false; }
  }

  selfcheckWanted(now) {
    if (this.selfcheckTriedAt !== null && now - this.selfcheckTriedAt < SELFCHECK_BUSY_RETRY_MS) return false;
    return this.selfcheckAt === null || now - this.selfcheckAt >= SELFCHECK_REFRESH_MS;
  }

  // Due (never written, or a switch or rollback asked for it) or older than VERSION_FACTS_REFRESH_MS; a failed read waits VERSION_FACTS_RETRY_MS.
  factsWanted(now) {
    const retryOk = this.factsTriedAt === null || now - this.factsTriedAt >= VERSION_FACTS_RETRY_MS;
    if (this.factsDue || this.factsAt === null) return retryOk;
    return retryOk && now - this.factsAt >= VERSION_FACTS_REFRESH_MS;
  }

  // One pass: every unanswered request, oldest first, then the facts when they are due. Returns what it did (for tests and logs).
  async step() {
    const box = await this.box();
    if (!box) return { answered: [], facts: false };
    const answered = [];
    let pending = [];
    try { pending = await box.pending(); } catch { pending = []; }
    for (const request of pending) {
      if (request.refused) continue;
      const left = Date.parse(request.deadline) - this.clock();
      let fields;
      if (left <= 0) fields = { ok: false, code: UPGRADE_REQUEST_EXPIRED, tool: { exit: null, status: null }, result: null };
      else {
        let response;
        try { response = responseFromTool(request, await this.tool(request, Math.min(left, UPGRADE_TIMEOUT_MS[request.kind])), this.clock); }
        catch { response = { ok: false, code: TOOL_NOT_RUN, tool: { exit: null, status: null }, result: null }; }
        fields = { ok: response.ok, code: response.code, tool: response.tool, result: response.result };
        // The facts as an answer are the freshest facts there are.
        if (request.kind === 'linux-version-facts' && response.ok) { try { await box.writeVersionFacts(response.result); this.factsAt = this.clock(); this.factsDue = false; } catch { /* the next refresh */ } }
        if (['linux-upgrade-switch', 'linux-upgrade-rollback'].includes(request.kind)) this.factsDue = true;
      }
      try { await box.respond(request, fields); answered.push([request.kind, fields.ok, fields.code]); } catch { /* answered already, or the next pass */ }
      if (this.factsDue && ['linux-upgrade-switch', 'linux-upgrade-rollback'].includes(request.kind)) await this.refreshFacts(box);
    }
    let facts = false;
    if (this.factsWanted(this.clock())) facts = await this.refreshFacts(box);
    try { await box.sweep('responses'); } catch { /* best effort */ }
    return { answered, facts };
  }
}
