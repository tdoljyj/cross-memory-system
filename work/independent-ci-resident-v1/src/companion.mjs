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
import { HEX64, check } from './canonical.mjs';

export const COMPANION_CONFIG_CONTRACT = 'clued.independent-ci.resident-companion-config/1';
// The Linux side of the Source v2 bridge spool (protected-job-bridge-v4/mailbox.mjs LINUX_ROOT): only its
// outgoing names are listed, to know when a relay call has something to move.
export const LINUX_OUTGOING = '/var/lib/clued-independent-ci/formal-spool/outgoing';
// One callback round, the same value as protected-job-bridge-v4/protocol.mjs CALLBACK_WINDOW_MS (test-pinned).
export const CALLBACK_WINDOW_MS = 120_000;

export function validateCompanionConfig(c) {
  check(c && c.contract === COMPANION_CONFIG_CONTRACT, 'COMPANION_CONFIG_CONTRACT_INVALID');
  for (const k of ['wslExe', 'powershellExe', 'relayScript', 'bundleScript', 'windowsSpool']) check(typeof c[k] === 'string' && /^[A-Z]:\\/.test(c[k]), 'COMPANION_CONFIG_PATH_INVALID', k);
  check(c.distribution === 'Ubuntu-24.04', 'COMPANION_DISTRIBUTION_FIXED');
  check(HEX64.test(c.bridgeManifestSha256), 'COMPANION_BRIDGE_PIN_INVALID');
  check(c.linuxTool === '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux', 'COMPANION_LINUX_TOOL_FIXED');
  return Object.freeze({ ...c });
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
    archiveStatus: instance => { check(/^[0-9a-f]{16}-[0-9a-f]{12}_[a-z0-9][a-z0-9-]{0,39}$/.test(instance), 'COMPANION_TOOL_ARGS_INVALID'); return wsl(cfg.linuxTool, 'archive-status', '--instance', instance); },
    relay: (mode, seq) => {
      check(['SendIssue', 'ReceiveChallenge', 'SendResponse', 'ReceiveResult', 'ReceiveBlocked'].includes(mode) && Number.isSafeInteger(seq) && seq >= 0 && seq <= 32, 'COMPANION_RELAY_ARGS_INVALID');
      return [cfg.powershellExe, '-NoProfile', '-NonInteractive', '-File', cfg.relayScript, '-Mode', mode, '-Sequence', String(seq), '-ExpectedBundleSha256', cfg.bridgeManifestSha256];
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
  //   readPull(pr) -> argv (pr-head; without it the companion answers PR_HEAD_UNAVAILABLE) }
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

  // relay: true = record transferred, false = nothing there yet, throws on any refusal.
  async relay(mode, seq) {
    const r = await this.run(this.a.relay(mode, seq), { timeoutMs: 40_000 });
    const v = json(r.stdout);
    if (r.code === 0 && v?.status === 'PUBLIC_RECORD_TRANSFERRED' && v.terminalConfirmed === true) return true;
    if (v?.childError?.reason === 'ENOENT' && v.terminalConfirmed === true) return false;
    check(false, 'RELAY_REFUSED_NO_RETRY');
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
      if (names === null || names.has('blocked.ready.json')) { await live(); try { if (await this.relay('ReceiveBlocked', 0)) return true; } catch { return false; } }
      await this.sleep(1000);
    }
    return false;
  }

  // The bridge pump that run-batch.ps1 performs today (lines 86-89), moved out of the elevated
  // process unchanged in meaning: issue -> worker -> challenge/response rounds -> result.
  // Owner abort (DESIGN §6.5): a cancel of this request from the service ends the pump at its next wait step with
  // COMPANION_PUMP_CANCELLED. No relay call starts after it; one already running ends first (at most 40 s). It only
  // stops relaying; the worker unit is never stopped or killed. A cancel file that cannot be read is no cancel.
  async pump(request) {
    const deadline = Date.parse(request.deadline);
    const spool = this.cfg.windowsSpool;
    const ready = name => this.fileExists(`${spool}\\outgoing\\${name}.ready.json`);
    // Without a listing, every record is "maybe there" and the relay itself is the probe (the v1 way).
    const listed = (names, name) => names === null || names.has(`${name}.ready.json`);
    const cancelled = async () => { try { return await this.mailbox.cancelled(request); } catch { return false; } };
    const live = async () => { check(!(await cancelled()), 'COMPANION_PUMP_CANCELLED'); };
    const relay = async (mode, seq) => { await live(); return this.relay(mode, seq); };
    try {
      while (!(await ready('issue'))) { check(this.clock() < deadline, 'ACTUAL_ISSUE_NOT_PUBLISHED'); await live(); await this.sleep(100); }
      check(await relay('SendIssue', 0), 'ISSUE_TRANSFER_UNCONFIRMED');
      await live(); // a cancel that came with the issue transfer starts no worker
      const start = await this.run(this.a.startNoBlock('clued-ci-worker', request.jobId), { timeoutMs: 30_000 });
      check(start.code === 0, 'LINUX_WORKER_START_UNCONFIRMED');
      let sequence = 1, blockedRefused = false;
      // A refused ReceiveBlocked is remembered (never tried twice); one that only found nothing is not.
      const receiveBlocked = async () => { await live(); try { return await this.relay('ReceiveBlocked', 0); } catch (e) { blockedRefused = true; throw e; } };
      try {
        for (;;) {
          check(this.clock() < deadline, 'FORMAL_BRIDGE_STAGE_DEADLINE');
          await live();
          const names = await this.linuxReady();
          // The worker's clean refusal (bridge v4 'blocked') means it has ended: it goes before a stale challenge.
          if (names?.has('blocked.ready.json') && await receiveBlocked()) break;
          // Then a challenge: a callback has a deadline (CALLBACK_WINDOW_MS), the result does not hurry.
          if (sequence <= 32 && listed(names, `challenge-${String(sequence).padStart(2, '0')}`) && await relay('ReceiveChallenge', sequence)) {
            const responseDeadline = this.clock() + CALLBACK_WINDOW_MS;
            const name = `response-${String(sequence).padStart(2, '0')}`;
            while (!(await ready(name))) { check(this.clock() < responseDeadline, 'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED'); await live(); await this.sleep(100); }
            check(await relay('SendResponse', sequence), 'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED');
            sequence += 1;
            continue;
          }
          if (listed(names, 'result') && await relay('ReceiveResult', 0)) break;
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
