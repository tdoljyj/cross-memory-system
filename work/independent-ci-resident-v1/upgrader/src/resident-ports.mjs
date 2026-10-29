// The upgrader's view of, and requests to, the resident (spec A11: the frozen observation surface; every later resident
// keeps these). The upgrader never writes the resident's state: it asks through the same drop boxes as the Owner
// (requests\ for the pause and the intake hold, owner\ for the upgrade-resume), and only reads:
//   state\PAUSED.json            raw bytes' sha and source.requestSha256
//   state\ledger\*\              entries without 90-terminal.json (open batches)
//   state\status.json            executor.state, current, writtenAt, node.probe.at (leniently)
//   state\receipts\<seq>-<type>  names; bodies of service-start, train-run-intent and train-run
//   broker\requests|responses    requests without an answer
//   mailbox\responses\heartbeat.json  the companion's heartbeat
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256 } from '../../src/canonical.mjs';
import { exists, readBounded, writeNew } from '../../src/store.mjs';
import { Inbox } from '../../src/inbox.mjs';
import { intakePauseRequest, intakeResumeRequest } from '../../src/intake-pause.mjs';
import { upgradeResumeRequest } from '../../src/upgrade-mailbox.mjs';

export const PAUSE_CONTRACT = 'clued.independent-ci.resident-pause/1'; // executor.mjs PAUSE_CONTRACT (frozen, A11)
export const HOLDER_UPGRADE = 'resident-upgrade';
export const HOLD_MINUTES = 120;
export const HOLD_RENEW_AFTER_MS = 30 * 60_000; // renewed when less than 90 of its 120 minutes are left (node-duty.mjs)
const RECEIPT = /^(\d{8})-([a-z0-9-]{1,48})\.json$/;
const BODY_TYPES = new Set(['service-start', 'train-run-intent', 'train-run']);
const STATUS_MAX = 256 * 1024;

// The exact bytes of one pause request (executor.mjs takePauseRequests: { contract, reason }).
export function pauseRequestBytes(opId, seq) {
  return Buffer.from(canonicalJson({ contract: PAUSE_CONTRACT, reason: `resident-upgrade ${opId} ${seq}` }) + '\n', 'utf8');
}

const msOf = v => (typeof v === 'string' && Number.isFinite(Date.parse(v))) ? Date.parse(v) : (Number.isSafeInteger(v) && v > 0 ? v : null);

export class ResidentPort {
  constructor(root, { clock = Date.now } = {}) {
    this.root = root;
    this.state = path.join(root, 'state');
    this.requests = path.join(root, 'requests');
    this.owner = path.join(root, 'owner');
    this.clock = clock;
    this.lastHold = new Map();
  }

  async drop(dir, value) { return Inbox.drop(dir, value, this.clock); }

  async hold(opId) {
    const last = this.lastHold.get(opId);
    if (last !== undefined && this.clock() - last < HOLD_RENEW_AFTER_MS) return false;
    await this.drop(this.requests, intakePauseRequest({ holder: HOLDER_UPGRADE, minutes: HOLD_MINUTES, reason: `resident-upgrade ${opId}` }, this.clock));
    this.lastHold.set(opId, this.clock());
    return true;
  }

  async liftHold(opId) {
    await this.drop(this.requests, intakeResumeRequest({ holder: HOLDER_UPGRADE, reason: `resident-upgrade ${opId}` }, this.clock));
    this.lastHold.delete(opId);
    return true;
  }

  // Create-only; the same bytes already there are the same request.
  async requestPause(name, bytes) {
    const file = path.join(this.requests, name);
    try {
      const handle = await fs.open(file, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  }

  pauseRequestPending(name) { return exists(path.join(this.requests, name)); }

  // Back out of requests\ into the op's own directory (rename, never replace).
  async withdrawPause(name, toFile) {
    const from = path.join(this.requests, name);
    if (!(await exists(from)) || (await exists(toFile))) return false;
    try { await fs.rename(from, toFile); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async pauseState() {
    const file = path.join(this.state, 'PAUSED.json');
    if (!(await exists(file))) return null;
    const bytes = await fs.readFile(file);
    let requestSha256 = null;
    try { const v = JSON.parse(bytes.toString('utf8')); requestSha256 = typeof v?.source?.requestSha256 === 'string' ? v.source.requestSha256 : null; } catch { /* a torn record is still a pause */ }
    return { sha256: sha256(bytes), requestSha256 };
  }

  async openBatches() {
    const dir = path.join(this.state, 'ledger');
    let names;
    try { names = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    let open = 0;
    for (const d of names) if (d.isDirectory() && !(await exists(path.join(dir, d.name, '90-terminal.json')))) open += 1;
    return open;
  }

  // Lenient: null when the file is missing or unreadable.
  async status() {
    try {
      const v = JSON.parse((await readBounded(path.join(this.state, 'status.json'), STATUS_MAX, 'STATUS_REFUSED')).toString('utf8'));
      return { writtenAt: msOf(v.writtenAt), executorState: typeof v.executor?.state === 'string' ? v.executor.state : null,
        current: v.current !== null && v.current !== undefined, probeAt: msOf(v.node?.probe?.at) };
    } catch { return null; }
  }

  async halted() { return (await this.status())?.executorState === 'HALTED'; }

  async receiptNames() {
    let names;
    try { names = await fs.readdir(path.join(this.state, 'receipts')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return names.map(n => RECEIPT.exec(n)).filter(Boolean).map(m => ({ name: m[0], seq: Number(m[1]), type: m[2] })).sort((a, b) => a.seq - b.seq);
  }

  async receiptHead() { const all = await this.receiptNames(); return all.length ? all[all.length - 1].seq : 0; }

  // The receipts after `seq` of the three frozen types, with their bodies.
  async receiptsSince(seq) {
    const out = [];
    for (const r of await this.receiptNames()) {
      if (r.seq <= seq || !BODY_TYPES.has(r.type)) continue;
      let body = null;
      try { body = JSON.parse(await fs.readFile(path.join(this.state, 'receipts', r.name), 'utf8')).body ?? null; } catch { body = null; }
      out.push({ seq: r.seq, type: r.type, body });
    }
    return out;
  }

  // A stage 10 run is open while the newest of its two receipt types is the intent.
  async trainOpen() {
    const train = (await this.receiptNames()).filter(r => r.type === 'train-run-intent' || r.type === 'train-run');
    return train.length > 0 && train[train.length - 1].type === 'train-run-intent';
  }

  async brokerPending() {
    const req = path.join(this.root, 'broker', 'requests'), res = path.join(this.root, 'broker', 'responses');
    let names;
    try { names = (await fs.readdir(req)).filter(n => n.endsWith('.json') && !n.startsWith('.')); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    let pending = 0;
    for (const n of names) if (!(await exists(path.join(res, n)))) pending += 1;
    return pending;
  }

  async companionHeartbeat() {
    try {
      const v = JSON.parse((await readBounded(path.join(this.root, 'mailbox', 'responses', 'heartbeat.json'), 512, 'HEARTBEAT_REFUSED')).toString('utf8'));
      return Number.isSafeInteger(v?.at) ? v.at : null;
    } catch { return null; }
  }

  // owner\ (only administrators create there; the upgrader runs as SYSTEM): the resident compares pausedSha256 and swaps.
  async requestUpgradeResume({ pausedSha256, opId, generation }) {
    const value = upgradeResumeRequest({ pausedSha256, opId, generation }, this.clock);
    await writeNew(path.join(this.owner, Inbox.fileName(this.clock())), value);
    return true;
  }
}
