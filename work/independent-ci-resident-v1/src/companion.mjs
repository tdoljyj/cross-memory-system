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

export function validateCompanionConfig(c) {
  check(c && c.contract === COMPANION_CONFIG_CONTRACT, 'COMPANION_CONFIG_CONTRACT_INVALID');
  for (const k of ['wslExe', 'powershellExe', 'relayScript', 'bundleScript', 'windowsSpool']) check(typeof c[k] === 'string' && /^[A-Z]:\\/.test(c[k]), 'COMPANION_CONFIG_PATH_INVALID', k);
  check(c.distribution === 'Ubuntu-24.04', 'COMPANION_DISTRIBUTION_FIXED');
  check(HEX64.test(c.bridgeManifestSha256), 'COMPANION_BRIDGE_PIN_INVALID');
  check(c.linuxTool === '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux', 'COMPANION_LINUX_TOOL_FIXED');
  return Object.freeze({ ...c });
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

export class Companion {
  // ports: { cfg, mailbox, run(argv,{timeoutMs}) -> {code, stdout, stderr}, fileExists(path), sleep(ms), clock() }
  constructor(ports) {
    Object.assign(this, ports);
    this.a = argv(ports.cfg);
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

  // The bridge pump that run-batch.ps1 performs today (lines 86-89), moved out of the elevated
  // process unchanged in meaning: issue -> worker -> challenge/response rounds -> result.
  async pump(request) {
    const deadline = Date.parse(request.deadline);
    const spool = this.cfg.windowsSpool;
    const ready = name => this.fileExists(`${spool}\\outgoing\\${name}.ready.json`);
    try {
      while (!(await ready('issue'))) { check(this.clock() < deadline, 'ACTUAL_ISSUE_NOT_PUBLISHED'); await this.sleep(100); }
      check(await this.relay('SendIssue', 0), 'ISSUE_TRANSFER_UNCONFIRMED');
      const start = await this.run(this.a.startNoBlock('clued-ci-worker', request.jobId), { timeoutMs: 30_000 });
      check(start.code === 0, 'LINUX_WORKER_START_UNCONFIRMED');
      let sequence = 1;
      for (;;) {
        check(this.clock() < deadline, 'FORMAL_BRIDGE_STAGE_DEADLINE');
        // Challenge first: a callback has a 30 s deadline, the result does not hurry (Source v2 order).
        if (sequence <= 32 && await this.relay('ReceiveChallenge', sequence)) {
          const responseDeadline = this.clock() + 30_000;
          const name = `response-${String(sequence).padStart(2, '0')}`;
          while (!(await ready(name))) { check(this.clock() < responseDeadline, 'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED'); await this.sleep(100); }
          check(await this.relay('SendResponse', sequence), 'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED');
          sequence += 1;
          continue;
        }
        if (await this.relay('ReceiveResult', 0)) break;
        // The worker's clean refusal before any preparation (bridge v4 'blocked'): the issuer ends cleanly.
        if (await this.relay('ReceiveBlocked', 0)) break;
        await this.sleep(100);
      }
      const until = this.clock() + 30_000;
      for (;;) {
        const s = await this.run(this.a.activeState('clued-ci-worker', request.jobId), { timeoutMs: 15_000 });
        if (s.code === 0 && ['inactive', 'failed'].includes(s.stdout.trim())) break;
        check(this.clock() < until, 'FORMAL_WORKER_TERMINAL_UNCONFIRMED');
        await this.sleep(500);
      }
      return { ok: true, proof: await this.quiescence(request.batchId) };
    } catch (error) {
      // Never stop or kill the worker: report what is known and let the service classify.
      return { ok: false, code: /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code ?? '') ? error.code : 'COMPANION_PUMP_UNCONFIRMED', proof: await this.quiescence(request.batchId) };
    }
  }

  // One pass over pending requests, oldest first. A malformed request is answered as refused.
  async step() {
    await this.mailbox.beat();
    for (const request of await this.mailbox.pending()) {
      if (request.refused) continue; // unreadable requests are left for the service's own audit
      if (this.clock() >= Date.parse(request.deadline)) { await this.mailbox.respond(request, { ok: false, code: 'COMPANION_REQUEST_EXPIRED' }); continue; }
      let answer;
      try { answer = await this.handle(request); } catch { answer = { ok: false, code: 'COMPANION_HANDLER_UNCONFIRMED' }; }
      await this.mailbox.respond(request, { ok: answer.ok === true, code: answer.ok ? null : (answer.code ?? 'COMPANION_HANDLER_UNCONFIRMED'), proof: answer.proof ?? null, directory: answer.directory ?? null, verified: answer.verified ?? null, usage: answer.usage ?? null });
    }
  }
}
