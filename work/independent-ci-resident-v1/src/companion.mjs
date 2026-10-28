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
import { BATCH_ID } from './mailbox.mjs';
import { HEX64, check, exactKeys } from './canonical.mjs';
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
const RELAY_RECEIPT_CONTRACT = 'clued.independent-ci.formal-public-relay-receipt/2';
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

export function validateCompanionConfig(c) {
  exactKeys(c, ['contract', 'wslExe', 'powershellExe', 'relayScript', 'bundleScript', 'windowsSpool', 'distribution', 'bridgeManifestSha256', 'linuxTool', 'node', 'nodeProfileSha256'], 'COMPANION_CONFIG_KEYS_INVALID');
  check(c && c.contract === COMPANION_CONFIG_CONTRACT, 'COMPANION_CONFIG_CONTRACT_INVALID');
  for (const k of ['wslExe', 'powershellExe', 'relayScript', 'bundleScript', 'windowsSpool']) check(typeof c[k] === 'string' && /^[A-Z]:\\/.test(c[k]), 'COMPANION_CONFIG_PATH_INVALID', k);
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
    activeState: (template, instance) => wsl('/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', unit(template, instance)),
    linuxTool: (sub, id) => { check(['quiescence'].includes(sub) && BATCH_ID.test(id), 'COMPANION_TOOL_ARGS_INVALID'); return wsl(cfg.linuxTool, sub, '--batch', id); },
    archiveUsage: () => wsl(cfg.linuxTool, 'archive-usage'),
    linuxOutgoing: () => wsl('/usr/bin/ls', '-1', '-A', '--', LINUX_OUTGOING),
    linuxIncoming: () => wsl('/usr/bin/ls', '-1', '-A', '--', LINUX_INCOMING),
    linuxRelayProcs: () => wsl('/usr/bin/pgrep', '-f', '-a', RELAY_RECORD_PROCESS),
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
  //   SendResponse retry), log(entry) (the local relay log, DESIGN §25.5; optional, its failures are swallowed) }
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
      // Verbatim root-tool facts; the companion never synthesises a proof value itself.
      case 'linux-quiescence': return { ok: true, proof: await this.quiescence(request.batchId) };
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
    const until = Math.min(deadline, this.clock() + CALLBACK_WINDOW_MS + 30_000);
    while (this.clock() < until) {
      await live();
      const names = await this.linuxReady();
      if (names === null || names.has('blocked.ready.json')) { try { if (await this.relay('ReceiveBlocked', 0, { live, deadline })) return true; } catch (e) { if (e?.code === 'COMPANION_PUMP_CANCELLED') throw e; return false; } }
      await this.sleep(1000);
    }
    return false;
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
      while (!(await ready('issue'))) { check(this.clock() < deadline, 'ACTUAL_ISSUE_NOT_PUBLISHED'); await live(); await this.sleep(100); }
      check(await relay('SendIssue', 0, { deadline }), 'ISSUE_TRANSFER_UNCONFIRMED');
      await live(); // a cancel that came with the issue transfer starts no worker
      const start = await this.run(this.a.startNoBlock('clued-ci-worker', request.jobId), { timeoutMs: 30_000 });
      check(start.code === 0, 'LINUX_WORKER_START_UNCONFIRMED');
      let sequence = 1, blockedRefused = false;
      // When the pump first saw each challenge listed (its ReceiveChallenge retry budget). Without a listing the call itself
      // is the probe, and that call's own start stands in for it: a wrong guess only makes a response later (DESIGN §25.4).
      const firstSeen = new Map();
      const seenAt = (names, seq) => { if (firstSeen.has(seq)) return firstSeen.get(seq); if (names === null) return this.clock(); firstSeen.set(seq, this.clock()); return firstSeen.get(seq); };
      // A ReceiveBlocked refused for good is remembered (never tried twice); one that only found nothing, or ran out of
      // retries, is not.
      const receiveBlocked = async () => { try { return await relay('ReceiveBlocked', 0, { deadline }); } catch (e) { if (e?.permanent) blockedRefused = true; throw e; } };
      try {
        for (;;) {
          check(this.clock() < deadline, 'FORMAL_BRIDGE_STAGE_DEADLINE');
          await live();
          const names = await this.linuxReady();
          // The worker's clean refusal (bridge v4 'blocked') means it has ended: it goes before a stale challenge.
          if (names?.has('blocked.ready.json') && await receiveBlocked()) break;
          // Then a challenge: a callback has a deadline (CALLBACK_WINDOW_MS), the result does not hurry.
          const challenge = relayRecordName('ReceiveChallenge', sequence);
          if (sequence <= 32 && listed(names, challenge)) {
            if (await relay('ReceiveChallenge', sequence, { deadline, firstSeen: seenAt(names, sequence) })) {
              const responseDeadline = this.clock() + CALLBACK_WINDOW_MS;
              const name = relayRecordName('SendResponse', sequence), seq = sequence;
              while (!(await ready(name))) { check(this.clock() < responseDeadline, 'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED'); await live(); await this.sleep(100); }
              check(await relay('SendResponse', seq, { deadline, challengeDeadline: () => this.challengeDeadline(seq) }), 'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED');
              sequence += 1;
              continue;
            }
          }
          if (listed(names, 'result') && await relay('ReceiveResult', 0, { deadline })) break;
          if (names === null && await receiveBlocked()) break;
          // A listing every second is ample against a 120 s round and keeps the wsl.exe launches low.
          await this.sleep(names === null ? 100 : 1000);
        }
      } catch (error) {
        // An Owner abort stops the Windows issuer anyway: no blocked hand-over (it checks the cancel before each of its
        // steps), and the outer catch answers COMPANION_PUMP_CANCELLED.
        if (!blockedRefused && error?.code !== 'COMPANION_PUMP_CANCELLED') await this.handOverBlocked(deadline, live);
        throw error;
      }
      const until = this.clock() + 30_000;
      for (;;) {
        const s = await this.run(this.a.activeState('clued-ci-worker', request.jobId), { timeoutMs: 15_000 });
        if (s.code === 0 && ['inactive', 'failed'].includes(s.stdout.trim())) break;
        check(this.clock() < until, 'FORMAL_WORKER_TERMINAL_UNCONFIRMED');
        await live();
        await this.sleep(500);
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
    await this.mailbox.beat();
    for (const request of await this.mailbox.pending()) {
      if (request.refused) continue; // unreadable requests are left for the service's own audit
      if (this.clock() >= Date.parse(request.deadline)) { await this.mailbox.respond(request, { ok: false, code: 'COMPANION_REQUEST_EXPIRED' }); continue; }
      let answer;
      this.trees = [];
      try { answer = await this.handle(request); } catch { answer = { ok: false, code: 'COMPANION_HANDLER_UNCONFIRMED' }; }
      await this.mailbox.respond(request, { ok: answer.ok === true, code: answer.ok ? null : (answer.code ?? 'COMPANION_HANDLER_UNCONFIRMED'), proof: answer.proof ?? null, directory: answer.directory ?? null, verified: answer.verified ?? null, usage: answer.usage ?? null, pull: answer.pull ?? null,
        jobTree: jobTreeOf(this.trees) });
    }
  }
}
