// CluedCIUpgrader's entry (spec B1): node upgrader-main.mjs --root <resident root> --config-sha256 <sha of upgrader.json>
//
// Started by UpgraderServiceHost (LocalSystem, frozen with this code). One instance at a time (upgrade\lock\). Each pass:
// read the upgrade inbox (new upgrade or cancel requests), move the one active operation as far as it goes without waiting,
// write upgrade\status.json, then sleep until the operation's next look. An operation is the ops journal; this process keeps
// nothing that a restart would lose (an UPGRADER_STOPPED pause is only "the service was not running").
//
// The service host asks it to stop by creating upgrade\STOP-REQUESTED: the pass in progress finishes its current step and
// the process ends (exit 0). Ending in the middle of a step is safe as well: the next start resumes from the journal.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setInterval as intervals } from 'node:timers/promises';
import { ResidentError, check } from '../../src/canonical.mjs';
import { ensureDir, exists, readBounded } from '../../src/store.mjs';
import { Inbox } from '../../src/inbox.mjs';
import { acquireInstanceLock, processAlive } from '../../src/instance-lock.mjs';
import { parseGenerationCurrent } from '../../src/upgrade-mailbox.mjs';
import { loadUpgraderConfig } from './config.mjs';
import { parseInboxEntry, REQUEST_MAX_BYTES } from './request.mjs';
import { Journal, TERMINAL_FILE, CANCEL_FILE } from './journal.mjs';
import { Machine, stateOf } from './machine.mjs';
import { Generations } from './generations.mjs';
import { buildStatus, writeStatus } from './status.mjs';
import { ResidentPort } from './resident-ports.mjs';
import { LinuxPort } from './linux-port.mjs';
import { WindowsPort } from './windows-port.mjs';
import { grantClient } from './grant-client.mjs';
import { U } from './codes.mjs';

export const MAX_MOVES_PER_PASS = 64;
export const IDLE_MS = 60_000;
// The inbox is untrusted (any process of the Owner's session can drop files there): at most this many files are read a pass,
// and at most this many operations are opened in 24 hours; more requests are archived as ignored, with no operation.
export const INBOX_PER_TICK = 8;
export const MAX_NEW_OPS_PER_DAY = 48;
const DAY = 86_400_000;
const UUID_DIR = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// status.json op.lastFailure (Task 42fe5ae4): { step, code, where, applyCode, applyAt } or null.
export function lastFailureOf(view, steps) {
  const pick = (step, code, d) => (d && typeof d.where === 'string' ? { step, code, where: d.where, applyCode: d.applyCode ?? null, applyAt: d.applyAt ?? null } : null);
  if (view?.lastFailure) return pick(view.phase ?? null, view.code ?? null, view.lastFailure);
  const failed = [...(steps ?? [])].reverse().find(s => s.result && s.result.ok === false);
  return failed ? pick(failed.step, failed.result.code ?? null, failed.result.detail) : null;
}

export class Upgrader {
  constructor({ root, config, clock = Date.now, pid = process.pid, ports, generations = null, readPackage }) {
    this.root = root;
    this.config = config;
    this.clock = clock;
    this.pid = pid;
    this.ports = ports;
    this.gens = generations ?? new Generations(root);
    this.readPackage = readPackage;
    this.upgradeRoot = path.join(root, 'upgrade');
    this.opsRoot = path.join(this.upgradeRoot, 'ops');
    this.statusFile = path.join(this.upgradeRoot, 'status.json');
    this.machines = new Map();
    this.lastView = null;
    // The operations are scanned once, at open(); afterwards this process keeps the index itself (it is their only writer).
    this.activeId = null;
    this.recent = [];
    this.opened = [];
  }

  async open() {
    await ensureDir(this.opsRoot);
    this.inbox = await Inbox.open(path.join(this.upgradeRoot, 'inbox'), path.join(this.upgradeRoot, 'inbox-archive'), this.clock);
    const ops = await this.ops();
    this.activeId = ops.find(o => o.terminal === null)?.opId ?? null;
    for (const o of ops.filter(x => x.terminal)) this.noteTerminal(o.opId, o.terminal);
    const since = this.clock() - DAY;
    this.opened = ops.filter(o => o.createdMs >= since).map(() => this.clock());
    return this;
  }

  noteTerminal(opId, t) {
    this.recent.push({ opId, outcome: t.outcome, code: t.code, generation: t.generation, at: t.at });
    this.recent.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    this.recent = this.recent.slice(-10);
  }

  async ops() {
    let names = [];
    try { names = (await fs.readdir(this.opsRoot)).filter(n => UUID_DIR.test(n)); } catch { return []; }
    const out = [];
    for (const opId of names) {
      const dir = path.join(this.opsRoot, opId);
      const terminal = (await exists(path.join(dir, TERMINAL_FILE))) ? JSON.parse(await fs.readFile(path.join(dir, TERMINAL_FILE), 'utf8')) : null;
      const st = await fs.stat(path.join(dir, '000-request.json')).catch(() => null);
      out.push({ opId, terminal, createdMs: st?.mtimeMs ?? 0 });
    }
    return out.sort((a, b) => a.createdMs - b.createdMs || (a.opId < b.opId ? -1 : 1));
  }

  active() { return this.activeId ? { opId: this.activeId } : null; }

  async currentGeneration() {
    try { return parseGenerationCurrent(await readBounded(this.gens.currentFile, 8192, 'GENERATION_CURRENT_REFUSED')); } catch { return null; }
  }

  // New requests: an upgrade opens its operation (refused at once when another is active), a cancel is recorded in its
  // operation when that has not staged anything yet. Everything read is archived (processed / rejected / ignored).
  async intake() {
    for (const entry of await this.inbox.read(INBOX_PER_TICK, REQUEST_MAX_BYTES)) {
      if (!entry.bytes) { await this.inbox.dispose(entry.name, 'rejected'); continue; }
      const parsed = parseInboxEntry(entry.bytes);
      let disposition = 'rejected';
      if (parsed.kind === 'upgrade') {
        const id = parsed.value.requestId;
        const now = this.clock();
        this.opened = this.opened.filter(at => now - at < DAY);
        if (await exists(path.join(this.opsRoot, id))) disposition = 'ignored';
        else if (this.opened.length >= MAX_NEW_OPS_PER_DAY) disposition = 'ignored';
        else {
          const journal = await Journal.create(this.opsRoot, id, entry.bytes, { clock: this.clock, pid: this.pid });
          this.opened.push(now);
          if (this.activeId) this.noteTerminal(id, await journal.terminal({ outcome: 'REFUSED', code: U.ANOTHER_OP_ACTIVE, generation: (await this.currentGeneration())?.generation ?? 0 }));
          else this.activeId = id;
          disposition = 'processed';
        }
      } else if (parsed.kind === 'cancel') {
        const dir = path.join(this.opsRoot, parsed.value.requestId);
        const names = (await exists(dir)) ? await fs.readdir(dir) : null;
        const open = names && !names.includes(TERMINAL_FILE) && !names.includes(CANCEL_FILE);
        // Only before STAGE: once a package is staged the operation runs to its end (or rolls back).
        if (open && !names.some(n => /^06[0-9]-stage-windows\.intent\.json$/.test(n))) {
          await Journal.open(this.opsRoot, parsed.value.requestId, { clock: this.clock }).writeCancel(entry.bytes);
          disposition = 'processed';
        }
      }
      await this.inbox.dispose(entry.name, disposition);
    }
  }

  machine(opId) {
    if (!this.machines.has(opId)) {
      this.machines.set(opId, new Machine({ root: this.root, opId, config: this.config, clock: this.clock, pid: this.pid, ports: this.ports, generations: this.gens,
        ...(this.readPackage ? { readPackage: this.readPackage } : {}) }));
    }
    return this.machines.get(opId);
  }

  // One pass. Returns how long to wait before the next one.
  async tick() {
    await this.intake();
    let wait = IDLE_MS;
    let error = null;
    const active = this.active();
    if (active) {
      const m = this.machine(active.opId);
      try {
        for (let i = 0; i < MAX_MOVES_PER_PASS; i += 1) {
          const r = await m.step();
          if (r.done) {
            wait = 0;
            this.noteTerminal(active.opId, r.terminal);
            this.activeId = null;
            this.machines.delete(active.opId);
            break;
          }
          if (r.wait > 0) { wait = r.wait; break; }
        }
      } catch (e) {
        // Transient: the step stays open in the journal and is tried again on the next pass.
        error = e instanceof ResidentError ? e.code : 'UPGRADER_EXCEPTION';
        wait = Math.min(wait, 60_000);
      }
      await this.writeStatus(active.opId, error);
    } else {
      await this.writeStatus(null, null);
    }
    return wait;
  }

  async opView(opId, error) {
    const j = await Journal.open(this.opsRoot, opId).load();
    const m = this.machines.get(opId);
    const plan = j.plan;
    const open = j.steps.find(s => s.result === null) ?? null;
    const last = j.steps[j.steps.length - 1] ?? null;
    const view = m?.view ?? {};
    const grantResult = j.steps.find(s => s.step === 'grant')?.result ?? null;
    const lastPause = j.steps.filter(s => s.step === 'pause' && s.result?.ok).pop();
    let state = j.terminal ? j.terminal.outcome : (view.state ?? stateOf(open?.step ?? last?.step ?? null));
    if (!j.terminal && !open && !view.state) state = 'RUNNING';
    return {
      opId, node: this.config.node, fromGeneration: plan?.fromGeneration ?? null, toGeneration: plan?.toGeneration ?? null,
      packageManifestSha256: j.request?.packageManifestSha256 ?? null, state,
      phase: j.terminal ? 'terminal' : (open?.step ?? view.phase ?? last?.step ?? 'accept'),
      phaseSince: (open?.intent.at ?? last?.result?.at ?? j.terminal?.at ?? null),
      code: j.terminal?.code ?? error ?? view.code ?? null,
      grant: { requestId: view.grant?.requestId ?? null, confirmUrl: view.grant?.confirmUrl ?? null, status: grantResult ? (grantResult.ok ? 'consumed' : 'refused') : (view.grant?.status ?? null),
        grantId: grantResult?.detail?.grantId ?? null },
      drain: { openBatches: view.drain?.openBatches ?? null, deadline: view.drain?.deadline ?? null, nextTryAt: view.nextTryAt ?? null },
      pausedBy: lastPause?.result.detail.pausedBy ?? view.pausedBy ?? null,
      // Task 42fe5ae4: where the last Windows step failed and what upgrade-apply.ps1 said (machine.mjs applyFailure): the
      // rollback wait's own, else the newest failed result's. A view; the journal holds the same detail.
      lastFailure: lastFailureOf(view, j.steps),
    };
  }

  async writeStatus(opId, error) {
    const current = await this.currentGeneration();
    const recent = this.recent;
    const generations = [];
    for (const n of await this.gens.list()) {
      let pkg = null;
      try { pkg = JSON.parse(await fs.readFile(this.gens.recordFile(n), 'utf8')).packageManifestSha256 ?? null; } catch { pkg = null; }
      generations.push({ generation: n, packageManifestSha256: pkg, at: current?.generation === n ? current.at : null, state: 'kept' });
    }
    for (const name of await this.gens.listArchived()) {
      const n = Number(/^g([0-9]+)/.exec(name)[1]);
      let pkg = null;
      try { pkg = JSON.parse(await fs.readFile(path.join(this.gens.archiveRoot, name, 'generation.json'), 'utf8')).packageManifestSha256 ?? null; } catch { pkg = null; }
      generations.push({ generation: n, packageManifestSha256: pkg, at: null, state: 'archived' });
    }
    const op = opId ? await this.opView(opId, error) : null;
    const status = buildStatus({ clock: this.clock, pid: this.pid, current, op, recent, generations });
    this.lastView = status;
    try { await writeStatus(this.statusFile, status); } catch { /* a view: the next pass writes it again */ }
    return status;
  }
}

// The real ports for one installed node.
export async function realPorts({ root, config, upgraderDir, clock = Date.now }) {
  return {
    door: grantClient({ supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey, confirmOrigin: config.confirmOrigin, tokenFile: config.tokenFile }),
    resident: new ResidentPort(root, { clock }),
    windows: new WindowsPort({ upgraderDir }),
    linux: await LinuxPort.open(path.join(root, 'upgrade', 'mailbox'), { clock }),
  };
}

export async function main({ argv = process.argv.slice(2), clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), ports = null, once = false } = {}) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string' }, 'config-sha256': { type: 'string' }, once: { type: 'boolean' } }, strict: true });
  const root = values.root;
  check(typeof root === 'string' && path.isAbsolute(root), 'UPGRADER_ROOT_REQUIRED');
  const { config } = await loadUpgraderConfig(path.join(root, 'upgrader', 'config', 'upgrader.json'), values['config-sha256']);
  check(path.resolve(config.root).toLowerCase() === path.resolve(root).toLowerCase(), 'UPGRADER_CONFIG_ROOT_MISMATCH');
  await ensureDir(path.join(root, 'upgrade'));
  const lock = await acquireInstanceLock(path.join(root, 'upgrade', 'lock'), { alive: processAlive, clock });
  // This file's own directory: upgrader\<manifestSha>\upgrader\src -> upgrader\<manifestSha>.
  const upgraderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const upgrader = await new Upgrader({ root, config, clock, ports: ports ?? await realPorts({ root, config, upgraderDir, clock }) }).open();
  const stopFile = path.join(root, 'upgrade', 'STOP-REQUESTED');
  // A Windows compile alone can take ten minutes. Refresh the existing
  // lock heartbeat independently of the operation status and its long tick.
  const controller = new AbortController();
  let heartbeatFailure;
  const heartbeat = (async () => {
    for await (const _ of intervals(30_000, undefined, { signal: controller.signal })) {
      await lock.touch();
    }
  })().catch(error => { if (!controller.signal.aborted) heartbeatFailure = error; });
  try {
    for (;;) {
      if (await exists(stopFile)) {
        await fs.rename(stopFile, path.join(root, 'upgrade', 'lock', `stop-${clock()}.json`)).catch(() => {});
        return 0;
      }
      const wait = await upgrader.tick();
      if (heartbeatFailure) throw heartbeatFailure;
      if (once || values.once) return 0;
      await sleep(Math.max(1_000, Math.min(wait, IDLE_MS)));
    }
  } finally {
    controller.abort();
    await heartbeat;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), error => {
    process.stderr.write(`${JSON.stringify({ status: 'UPGRADER_FAILED', code: error?.code ?? 'UPGRADER_EXCEPTION' })}\n`);
    process.exit(2);
  });
}

