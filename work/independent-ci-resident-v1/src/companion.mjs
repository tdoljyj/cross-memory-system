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
import { BATCH_ID, validatePrune } from './mailbox.mjs';
import { HEX64, check, exactKeys, fail } from './canonical.mjs';
import { pinnedNodeProfile } from './node-profile.mjs';

export const COMPANION_CONFIG_CONTRACT = 'clued.independent-ci.resident-companion-config/2';
// The Linux side of the Source v2 bridge spool (protected-job-bridge-v4/mailbox.mjs LINUX_ROOT): only its
// outgoing names are listed, to know when a relay call has something to move.
export const LINUX_OUTGOING = '/var/lib/clued-independent-ci/formal-spool/outgoing';
// Its incoming names, listed only to tell whether a relayed record arrived (DESIGN §25.3).
export const LINUX_INCOMING = '/var/lib/clued-independent-ci/formal-spool/incoming';
// The Linux end of every relay call; a Send* retry waits until none is left running (DESIGN §25.3).
export const RELAY_RECORD_PROCESS = 'protected-job-bridge-v4/relay-record.mjs';
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
// After a failed callback round, the hand-over of the worker's blocked record is looked for at most this far apart (its window
// is CALLBACK_WINDOW_MS + 30 s; DESIGN §31.5).
export const HANDOVER_LISTING_CAP_MS = 5000;
export const listingDelayMs = (quietMs, capMs = LISTING_CAP_MS) => Math.min(capMs, Math.max(LISTING_MIN_MS, Math.floor(quietMs / LISTING_QUIET_DIVISOR)));
const WORKER_RUNNING_STATES = new Set(['activating', 'active', 'deactivating']);
const RELAY_RECEIPT_CONTRACT ='clued.independent-ci.formal-public-relay-receipt/2';
const CHILD_TRANSIENT_REASONS = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'EINTR', 'FORMAL_RELAY_STDIN_TIMEOUT']);
const CHILD_TRANSIENT_STAGES = new Set(['OPERATION', 'CONTEXT', 'STDIN', 'TRANSPORT', 'PACKET']);
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
  if (v.terminalConfirmed === true && v.failureCode === 'PUBLIC_CHILD_REFUSED_NO_RETRY' && ce && CHILD_TRANSIENT_REASONS.has(ce.reason) && CHILD_TRANSIENT_STAGES.has(ce.stage)) return 'CHILD_FAILED';
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
  return { at: new Date(at).toISOString(), mode, seq, attempt, ms,
    runner: { code: Number.isSafeInteger(r.code) ? r.code : null, timedOut: r.timedOut === true, tree: ['zero', 'unconfirmed'].includes(r.tree) ? r.tree : null, refused: code(r.refused) },
    receipt: { status: code(v.status), failureCode: code(v.failureCode), exitCode: Number.isSafeInteger(v.exitCode) ? v.exitCode : null,
      processIdPresent: v.processId !== null && v.processId !== undefined, terminalConfirmed: v.terminalConfirmed === true, childError: ce },
    class: klass, stderrTail: stderrTail(r.stderr) };
}

// DESIGN §33 (the 2026-10-29 first HALT): the path-valued keys of companion.json and which of them point into the installed CI
// Source, <root>\source\<ciSourceManifestSha256>\. A path key is a Source script unless it is named here as not one, so a new path
// key is held to the Source directory by default. A config whose script paths name another (older) Source directory runs
// nothing: the stage-0 bundle then reports BUNDLE_UNAVAILABLE and the relay cannot start.
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

// Hint mode (free-minutes design S20) is off unless the installed companion.json says so; it names the
// installed CI Source whose hosted-relay-v1 observer and pure hint attestation the companion runs.
export function validateHintConfig(h) {
  if (h === undefined || h === null) return Object.freeze({ enabled: false, ciSourceManifestSha256: null });
  check(typeof h === 'object' && Object.keys(h).sort().join('|') === 'ciSourceManifestSha256|enabled' && typeof h.enabled === 'boolean'
    && (h.enabled === false || HEX64.test(h.ciSourceManifestSha256 ?? '')), 'COMPANION_HINT_CONFIG_INVALID');
  return Object.freeze({ enabled: h.enabled, ciSourceManifestSha256: h.ciSourceManifestSha256 ?? null });
}

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
    linuxTool: (sub, id) => { check(['quiescence'].includes(sub) && BATCH_ID.test(id), 'COMPANION_TOOL_ARGS_INVALID'); return wsl(cfg.linuxTool, sub, '--batch', id); },
    archiveUsage: () => wsl(cfg.linuxTool, 'archive-usage'),
    // DESIGN §34: one retention pass of the Linux spool (the root tool plans, re-checks and deletes; nothing variable here).
    archivePrune: () => wsl(cfg.linuxTool, 'archive-prune'),
    linuxOutgoing: () => wsl('/usr/bin/ls', '-1', '-A', '--', LINUX_OUTGOING),
    linuxIncoming: () => wsl('/usr/bin/ls', '-1', '-A', '--', LINUX_INCOMING),
    linuxRelayProcs: () => wsl('/usr/bin/pgrep', '-f', '-a', RELAY_RECORD_PROCESS),
    // DESIGN §32: the memory gate's one wsl.exe per check.
    memoryFacts: () => wsl('/usr/bin/cat', '--', ...MEMORY_FACTS_FILES),
    archiveStatus: instance => { check(/^[0-9a-f]{16}-[0-9a-f]{12}_[a-z0-9][a-z0-9-]{0,39}$/.test(instance), 'COMPANION_TOOL_ARGS_INVALID'); return wsl(cfg.linuxTool, 'archive-status', '--instance', instance); },
    relay: (mode, seq) => {
      check(['SendIssue', 'ReceiveChallenge', 'SendResponse', 'ReceiveResult', 'ReceiveBlocked'].includes(mode) && Number.isSafeInteger(seq) && seq >= 0 && seq <= 32, 'COMPANION_RELAY_ARGS_INVALID');
      return [cfg.powershellExe, '-NoProfile', '-NonInteractive', '-File', cfg.relayScript, '-Mode', mode, '-Sequence', String(seq), '-ExpectedBundleSha256', cfg.bridgeManifestSha256, '-ExpectedNodeProfileSha256', cfg.nodeProfileSha256];
    },
    bundle: id => { check(BATCH_ID.test(id), 'COMPANION_BUNDLE_ARGS_INVALID'); return [cfg.powershellExe, '-NoProfile', '-NonInteractive', '-File', cfg.bundleScript, '-BatchId', id]; },
    checkRefs: id => { check(BATCH_ID.test(id), 'COMPANION_BUNDLE_ARGS_INVALID'); return [cfg.powershellExe, '-NoProfile', '-NonInteractive', '-File', cfg.bundleScript, '-BatchId', id, '-CheckRefs']; },
    keepalive: () => [cfg.wslExe, '--distribution', cfg.distribution, '--exec', '/bin/sleep', 'infinity'],
  };
}

const json = text => { try { return JSON.parse(text); } catch { return null; } };

// pr-head (phase 2, step 1): the PR's state and head over the Owner's own gh login, read-only, fixed argv.
export const PR_HEAD_TIMEOUT_MS = 30_000;
export function readPullArgv(ghExe, repo, pr) {
  check(typeof ghExe === 'string' && /^[A-Z]:\\/.test(ghExe) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') && Number.isSafeInteger(pr) && pr > 0 && pr < 1e9, 'COMPANION_PR_HEAD_ARGS_INVALID');
  return [ghExe, 'api', '--method', 'GET', `repos/${repo}/pulls/${pr}`, '--jq', '{number: .number, state: .state, merged: .merged, head: .head.sha}'];
}
// The gh answer -> { number, state: open | closed | merged, headSha }, or null when it is not exactly that shape.
export function parsePull(stdout, pr) {
  const v = json(stdout);
  if (!v || v.number !== pr || !['open', 'closed'].includes(v.state) || typeof v.merged !== 'boolean' || !/^[0-9a-f]{40}$/.test(v.head ?? '')) return null;
  return { number: pr, state: v.merged ? 'merged' : v.state, headSha: v.head };
}

// DESIGN §24: the answer's jobTree from what the job host said about each child of one request that did not simply end
// on its own (runner.mjs `tree`): none -> null; all drained -> 'zero'; any other -> 'unconfirmed'.
export function jobTreeOf(trees) {
  if (trees.length === 0) return null;
  return trees.every(t => t === 'zero') ? 'zero' : 'unconfirmed';
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
    // Every child of the request in hand that the job host had to end (or could not show ended) is noted for its answer.
    this.trees = [];
    this.run = async (a, o) => {
      const r = await ports.run(a, o);
      if (r?.tree === 'zero' || r?.tree === 'unconfirmed') this.trees.push(r.tree);
      return r;
    };
  }

  async quiescence(batchId) {
    const r = await this.run(this.a.linuxTool('quiescence', batchId), { timeoutMs: 30_000 });
    const v = r.code === 0 ? json(r.stdout) : null;
    return { linuxUnitsInactive: v?.linuxUnitsInactive === true, containersZero: v?.containersZero === true };
  }

  async handle(request) {
    switch (request.kind) {
      case 'build-bundle': {
        const r = await this.run(this.a.bundle(request.batchId), { timeoutMs: 30 * 60_000 });
        const v = r.code === 0 ? json(r.stdout) : null;
        return { ok: v?.status === 'BUNDLE_WRITTEN', code: v?.status === 'BUNDLE_WRITTEN' ? null : 'BUNDLE_UNAVAILABLE' };
      }
      case 'prepare-workspaces': {
        const r = await this.run(this.a.startWait('clued-ci-wsprep', request.batchId), { timeoutMs: 20 * 60_000 });
        const proof = await this.quiescence(request.batchId);
        if (r.code === 0) return { ok: true, proof };
        return { ok: false, code: proof.linuxUnitsInactive ? 'WORKSPACE_PREPARATION_REFUSED' : 'WORKSPACE_PREPARATION_UNCONFIRMED', proof };
      }
      case 'archive-linux': {
        const r = await this.run(this.a.startWait('clued-ci-archive', `${request.batchId}_${request.reason}`), { timeoutMs: 5 * 60_000 });
        const s = await this.run(this.a.archiveStatus(`${request.batchId}_${request.reason}`), { timeoutMs: 30_000 });
        const v = s.code === 0 ? json(s.stdout) : null;
        const verified = r.code === 0 && v?.verified === true && typeof v.directory === 'string';
        return { ok: verified, code: verified ? null : 'LINUX_ARCHIVE_UNCONFIRMED', verified, directory: verified ? v.directory : null };
      }
      case 'relay-stage': return this.pump(request);
      // Source v2 S9 / lesson b29: before the first scanner stage, the refs must still be the bundle's.
      case 'check-refs': {
        const r = await this.run(this.a.checkRefs(request.batchId), { timeoutMs: 5 * 60_000 });
        const v = json(r.stdout);
        if (r.code === 0 && v?.status === 'REMOTE_REFS_UNCHANGED') return { ok: true, code: null };
        return { ok: false, code: v?.status === 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' ? 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' : 'REMOTE_REFS_UNAVAILABLE' };
      }
      case 'archive-usage': {
        const r = await this.run(this.a.archiveUsage(), { timeoutMs: 2 * 60_000 });
        const v = r.code === 0 ? json(r.stdout) : null;
        const ok = v?.contract === 'clued.independent-ci.linux-archive-usage/1' && Number.isSafeInteger(v.bytes) && v.bytes >= 0 && Number.isSafeInteger(v.directories) && v.directories >= 0;
        return ok ? { ok: true, usage: { bytes: v.bytes, directories: v.directories } } : { ok: false, code: 'LINUX_ARCHIVE_USAGE_UNCONFIRMED' };
      }
      // DESIGN §34: the root tool's facts of one retention pass, carried as they are (exact shape) with the usage after it. A
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
      case 'linux-quiescence': return { ok: true, proof: await this.quiescence(request.batchId) };
      // DESIGN §32: the facts only (ring order, free blocks of at least that order); the service applies its threshold.
      case 'memory-ready': {
        const r = await this.run(this.a.memoryFacts(), { timeoutMs: RELAY_CHECK_TIMEOUT_MS });
        const memory = r.code === 0 && !('tree' in r) ? parseMemoryFacts(r.stdout) : null;
        return memory ? { ok: true, memory } : { ok: false, code: 'LINUX_MEMORY_UNREADABLE' };
      }
      case 'pr-head': {
        if (typeof this.readPull !== 'function') return { ok: false, code: 'PR_HEAD_UNAVAILABLE' };
        const r = await this.run(this.readPull(request.pr), { timeoutMs: PR_HEAD_TIMEOUT_MS });
        const pull = r.code === 0 ? parsePull(r.stdout, request.pr) : null;
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
    const relay = (mode, seq, budget = {}) => this.relay(mode, seq, { live, ...budget });
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
      await live(); // a cancel that came with the issue transfer starts no worker
      const startCalledAt = this.clock(); // no challenge can exist before the worker was asked to start
      const start = await this.run(this.a.startNoBlock('clued-ci-worker', request.jobId), { timeoutMs: 30_000 });
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
        if (workerRanEvidence(f) || sequence > 1) worker.ran = true;
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
      let eventAt = startedAt, lowerBound = startCalledAt, previousNames = null;
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
            if (await relay('ReceiveChallenge', sequence, { deadline, firstSeen: seenAt(names, sequence, anchor) })) {
              eventAt = this.clock();
              const responseDeadline = this.clock() + CALLBACK_WINDOW_MS;
              const name = relayRecordName('SendResponse', sequence), seq = sequence;
              while (!(await ready(name))) { check(this.clock() < responseDeadline, 'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED'); await live(); await this.sleep(100); }
              const sendingAt = this.clock();
              check(await relay('SendResponse', seq, { deadline, challengeDeadline: () => this.challengeDeadline(seq) }), 'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED');
              // The worker makes challenge k+1 only after it has response k, which cannot be before this transfer began; the
              // listing taken before the round (even one that already ran long) says nothing about the next challenge (MAJOR-1).
              lowerBound = Math.max(lowerBound, sendingAt);
              sequence += 1;
              eventAt = this.clock();
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
          await this.sleep(names === null ? 100 : this.paceListing({ quietMs: this.clock() - eventAt, untilFactsMs: worker.factsAt - this.clock() }));
        }
      } catch (error) {
        // An Owner abort stops the Windows issuer anyway: no blocked hand-over (it checks the cancel before each of its
        // steps), and the outer catch answers COMPANION_PUMP_CANCELLED. Signals B and C need none either: the final listing
        // held no blocked record, or the worker never ran (DESIGN §26).
        if (!blockedRefused && !['COMPANION_PUMP_CANCELLED', 'LINUX_WORKER_ENDED_WITHOUT_RECORD', 'LINUX_WORKER_NOT_STARTED'].includes(error?.code)) await this.handOverBlocked(deadline, live);
        throw error;
      }
      const until = this.clock() + 30_000;
      for (let look = 0; ; look += 1) {
        const s = parseUnitFacts(await this.run(this.a.unitFacts('clued-ci-worker', request.jobId), { timeoutMs: 15_000 }));
        if (s && ['inactive', 'failed'].includes(s.activeState)) break;
        check(this.clock() < until, 'FORMAL_WORKER_TERMINAL_UNCONFIRMED');
        await live();
        await this.sleep(Math.min(2000, 500 * 2 ** look)); // 0.5, 1, 2 s, then every 2 s: at most about 17 reads in the 30 s, not 60
      }
      return { ok: true, proof: await this.quiescence(request.batchId) };
    } catch (error) {
      // Never stop or kill the worker: report what is known and let the service classify. A cancelled pump answers
      // COMPANION_PUMP_CANCELLED whatever step it ended in, also a relay call that failed as the cancel came.
      const code = (await cancelled()) ? 'COMPANION_PUMP_CANCELLED' : /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code ?? '') ? error.code : 'COMPANION_PUMP_UNCONFIRMED';
      return { ok: false, code, proof: await this.quiescence(request.batchId) };
    }
  }

  // One pass over pending requests, oldest first. A malformed request is answered as refused.
  async step() {
    // The companion's own timer beats as well (companion-main.mjs, DESIGN §26); a beat that fails only misses this beat.
    try { await this.mailbox.beat(); } catch { /* a liveness hint only */ }
    for (const request of await this.mailbox.pending()) {
      if (request.refused) continue; // unreadable requests are left for the service's own audit
      if (this.clock() >= Date.parse(request.deadline)) { await this.mailbox.respond(request, { ok: false, code: 'COMPANION_REQUEST_EXPIRED' }); continue; }
      let answer;
      this.trees = [];
      try { answer = await this.handle(request); } catch { answer = { ok: false, code: 'COMPANION_HANDLER_UNCONFIRMED' }; }
      await this.mailbox.respond(request, { ok: answer.ok === true, code: answer.ok ? null : (answer.code ?? 'COMPANION_HANDLER_UNCONFIRMED'), proof: answer.proof ?? null, directory: answer.directory ?? null, verified: answer.verified ?? null, usage: answer.usage ?? null, pull: answer.pull ?? null,
        jobTree: jobTreeOf(this.trees), memory: answer.memory ?? null, prune: answer.prune ?? null });
    }
  }
}
