// A durable wake-up signal for the original merge controller (Task 3a0e4219).
// This lane never decides PR eligibility, reads a secret, merges, updates a
// branch or reruns CI. The fixed main workflow retains those original gates.
// A matching Source hash proves bytes only: Host qualification and execution
// authority remain the workflow's independently enforced prerequisites.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check, exactKeys, parseBoundedJson, UUID, HEX64 } from './canonical.mjs';
import { NODE_NAME, operationalIntakePause } from './node-duty.mjs';
import { dispatchByTrainEffect } from './panel-dispatch.mjs';
import { parseIncluded } from './poller.mjs';

export const RECONCILE_REPO = 'tdoljyj/cross-memory-system';
export const RECONCILE_WORKFLOW = 'clued-merge-reconcile.yml';
export const RECONCILE_REF = 'main';
export const RECONCILE_EVERY_MS = 5 * 60_000;
export const RECONCILE_MAX_DISPATCHES_PER_HOUR = 12;
export const RECONCILE_MAX_READS_PER_HOUR = 60;
export const RECONCILE_STATUS_FRESH_MS = 60_000;
export const RECONCILE_BACKOFF_MS = Object.freeze([60_000, 120_000, 240_000, 480_000, 900_000]);
export const RECONCILE_STATE_CONTRACT = 'clued.independent-ci.merge-reconcile-state/1';
const HOUR = 3_600_000, MAX_BYTES = 65_536, SOURCE_MAX_BYTES = 131_072;
const SHA = /^[a-f0-9]{40}$/;
const hash = b => createHash('sha256').update(b).digest('hex');
const time = v => Number.isSafeInteger(v) && v >= 0;
const includes = (xs, v) => xs.includes(v);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const identityKeys = ['contract', 'nodeName', 'repo', 'workflow', 'sourceSha256', 'lastTickAt', 'nextAt', 'reads', 'dispatches', 'pending', 'failures', 'lastCode', 'lastNotice'];

function args(ghExe, repo) {
  check(typeof ghExe === 'string' && /^[A-Z]:\\[^\r\n\0]+\.exe$/i.test(ghExe) && repo === RECONCILE_REPO, 'MERGE_RECONCILE_ARGS_REFUSED');
}
function identity({ nodeName, repo, pinnedSource }) {
  check(NODE_NAME.test(nodeName ?? '') && repo === RECONCILE_REPO && HEX64.test(pinnedSource ?? ''), 'MERGE_RECONCILE_IDENTITY_REFUSED');
}
export function reconcileSourceArgv(ghExe, repo) {
  args(ghExe, repo);
  return [ghExe, 'api', '--include', '--method', 'GET', `repos/${repo}/contents/.github/workflows/${RECONCILE_WORKFLOW}?ref=${RECONCILE_REF}`];
}
export function reconcileRunsArgv(ghExe, repo) {
  args(ghExe, repo);
  return [ghExe, 'api', '--include', '--method', 'GET', `repos/${repo}/actions/workflows/${RECONCILE_WORKFLOW}/runs?branch=${RECONCILE_REF}&per_page=100`];
}
export function reconcileDispatchArgv(ghExe, repo, requestId) {
  args(ghExe, repo); check(UUID.test(requestId ?? ''), 'MERGE_RECONCILE_REQUEST_REFUSED');
  return [ghExe, 'api', '--include', '--method', 'POST', `repos/${repo}/actions/workflows/${RECONCILE_WORKFLOW}/dispatches`,
    '-f', `ref=${RECONCILE_REF}`, '-f', `inputs[reconcile_request_id]=${requestId}`];
}

// Every absence is unknown. In particular, an old status contract without
// version consistency cannot authorize a new periodic control route.
export function reconcileDutyOf(status, nodeName, now) {
  if (!status || !time(status.writtenAt)) return 'STATUS_UNREADABLE';
  if (status.writtenAt > now) return 'STATUS_FROM_FUTURE';
  if (now - status.writtenAt > RECONCILE_STATUS_FRESH_MS) return 'STATUS_STALE';
  if (status.node?.name !== nodeName) return 'NODE_NAME_MISMATCH';
  if (status.node?.mode !== 'ACTIVE') return 'NOT_ACTIVE';
  if (status.paused !== false || status.halt !== null) return 'PAUSED_OR_HALTED';
  if (operationalIntakePause(status.intakePause) !== null) return 'INTAKE_HELD';
  if (status.versions?.consistent !== true || status.versions.upgrade !== null) return 'VERSION_OR_UPGRADE_HOLD';
  if ((status.draining !== undefined && status.draining !== false) || (status.drain !== undefined && status.drain !== null)
      || /DRAIN|UPGRADE/i.test(`${status.executor?.state ?? ''} ${status.executor?.reason ?? ''}`)) return 'DRAIN_HOLD';
  return null;
}

function initial({ nodeName, repo, pinnedSource }) {
  return { contract: RECONCILE_STATE_CONTRACT, nodeName, repo, workflow: RECONCILE_WORKFLOW, sourceSha256: pinnedSource,
    lastTickAt: 0, nextAt: 0, reads: [], dispatches: [], pending: null, failures: 0, lastCode: null, lastNotice: null };
}
function validateState(v, expected) {
  exactKeys(v, identityKeys, 'MERGE_RECONCILE_STATE_REFUSED');
  check(v.contract === RECONCILE_STATE_CONTRACT && v.nodeName === expected.nodeName && v.repo === expected.repo
    && v.workflow === RECONCILE_WORKFLOW && v.sourceSha256 === expected.pinnedSource, 'MERGE_RECONCILE_STATE_IDENTITY_REFUSED');
  check(time(v.lastTickAt) && time(v.nextAt)
    && Number.isSafeInteger(v.failures) && v.failures >= 0 && v.failures <= 1_000_000
    && [v.lastCode, v.lastNotice].every(x => x === null || typeof x === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(x)), 'MERGE_RECONCILE_STATE_REFUSED');
  for (const [rows, max] of [[v.reads, RECONCILE_MAX_READS_PER_HOUR], [v.dispatches, RECONCILE_MAX_DISPATCHES_PER_HOUR]]) {
    check(Array.isArray(rows) && rows.length <= max && rows.every((at, i) => time(at) && at <= v.lastTickAt && (!i || rows[i - 1] <= at)), 'MERGE_RECONCILE_STATE_REFUSED');
  }
  if (v.pending !== null) {
    exactKeys(v.pending, ['requestId', 'at', 'sourceSha256', 'phase'], 'MERGE_RECONCILE_STATE_REFUSED');
    check(UUID.test(v.pending.requestId ?? '') && time(v.pending.at) && v.pending.at <= v.lastTickAt
      && v.pending.sourceSha256 === expected.pinnedSource && includes(['INTENT', 'ACCEPTED', 'UNKNOWN'], v.pending.phase), 'MERGE_RECONCILE_STATE_REFUSED');
  }
  return v;
}

// One serialized companion lane owns this file. Atomic replacement protects
// restart recovery; it is not an interprocess lease or business authority.
export class MergeReconcileState {
  constructor(file, expected) { identity(expected); this.file = file; this.expected = expected; this.data = initial(expected); }
  static async open(file, expected) {
    const state = new MergeReconcileState(file, expected);
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      check(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES, 'MERGE_RECONCILE_STATE_REFUSED');
      state.data = validateState(parseBoundedJson(await handle.readFile(), MAX_BYTES, 'MERGE_RECONCILE_STATE_REFUSED'), expected);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
      // Only genuinely absent state is a first start. Corruption, bad identity
      // and permissions must never reset an existing dispatch/API ledger.
    } finally { await handle?.close(); }
    return state;
  }
  async save() {
    validateState(this.data, this.expected);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(this.data)); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp, this.file);
    } finally {
      await handle?.close();
      await fs.unlink(temp).catch(e => { if (e?.code !== 'ENOENT') throw e; });
    }
  }
}

function responseOf(result) {
  if (result?.timedOut || result?.refused) return null;
  try { return parseIncluded(result?.stdout); } catch { return null; }
}
function retryDelay(result, now) {
  const headers = String(result?.stdout ?? '').split(/\r?\n\r?\n/, 1)[0];
  const value = /^retry-after:\s*([^\r\n]+)\s*$/im.exec(headers)?.[1]?.trim();
  if (/^[0-9]+$/.test(value ?? '')) {
    const delay = Number(value) * 1000;
    return Number.isSafeInteger(delay) && Number.isSafeInteger(now + delay) ? Math.max(60_000, delay) : null;
  }
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? Math.max(60_000, at - now) : null;
}
function sourceMatches(reply, expected) {
  if (reply?.status !== 200) return false;
  try {
    const v = JSON.parse(reply.body);
    if (v.type !== 'file' || v.path !== `.github/workflows/${RECONCILE_WORKFLOW}` || v.encoding !== 'base64'
        || !SHA.test(v.sha ?? '') || !Number.isSafeInteger(v.size) || v.size < 1 || v.size > SOURCE_MAX_BYTES
        || typeof v.content !== 'string' || v.content.length > SOURCE_MAX_BYTES * 2 || !/^[A-Za-z0-9+/=\r\n]+$/.test(v.content)) return false;
    const bytes = Buffer.from(v.content, 'base64');
    return bytes.length === v.size && bytes.toString('base64') === v.content.replace(/[\r\n]/g, '') && hash(bytes) === expected;
  } catch { return false; }
}
function runsOf(reply) {
  if (reply?.status !== 200) return null;
  try {
    const value = JSON.parse(reply.body);
    if (!Array.isArray(value.workflow_runs) || value.workflow_runs.length > 100) return null;
    const rows = value.workflow_runs.map(v => {
      if (!Number.isSafeInteger(v.id) || v.id < 1 || v.head_branch !== RECONCILE_REF || !SHA.test(v.head_sha ?? '')
          || typeof v.display_title !== 'string' || v.display_title.length > 256 || typeof v.event !== 'string'
          || !includes(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'], v.status)
          || !Number.isFinite(Date.parse(v.created_at ?? ''))) fail('MERGE_RECONCILE_RUNS_REFUSED');
      return { id: v.id, title: v.display_title, event: v.event, status: v.status, at: Date.parse(v.created_at), headSha: v.head_sha };
    });
    return rows;
  } catch { return null; }
}

export class MergeReconciler {
  constructor(ports) {
    Object.assign(this, ports); identity(this); args(this.ghExe, this.repo);
    check(this.state?.data && this.state.expected?.nodeName === this.nodeName && this.state.expected?.repo === this.repo
      && this.state.expected?.pinnedSource === this.pinnedSource && typeof this.run === 'function' && typeof this.readStatus === 'function'
      && typeof this.clock === 'function', 'MERGE_RECONCILE_PORTS_REFUSED');
    this.busy = false;
  }
  async held() {
    let status;
    try { status = await this.readStatus(); } catch { return 'STATUS_UNREADABLE'; }
    return reconcileDutyOf(status, this.nodeName, this.clock());
  }
  async persist(now) { this.state.data.lastTickAt = now; await this.state.save(); }
  async notifyOnce(code) {
    if (this.state.data.lastNotice === code) return;
    this.state.data.lastNotice = code; await this.state.save();
    try { await this.notify?.(code, '合并队列自动对账未推进', code); } catch { /* a toast is not execution or proof */ }
  }
  async failed(code, result = null) {
    const now = this.clock(), d = this.state.data;
    d.failures = Math.min(1_000_000, d.failures + 1); d.lastCode = code;
    const delay = retryDelay(result, now) ?? RECONCILE_BACKOFF_MS[Math.min(d.failures, RECONCILE_BACKOFF_MS.length) - 1];
    d.nextAt = now + delay; await this.persist(now);
    if (d.failures >= 3 || includes(['SOURCE_MISMATCH', 'DISPATCH_UNKNOWN'], code)) await this.notifyOnce(code);
    return { skipped: code, retryAt: d.nextAt, pending: d.pending !== null };
  }
  // Reserve each API read durably before starting it. Failed reads cost the
  // same budget, and a process restart never restores that budget.
  async read(argv) {
    const now = this.clock(), d = this.state.data;
    if (now < d.lastTickAt) fail('MERGE_RECONCILE_CLOCK_BACKWARD');
    d.reads = d.reads.filter(at => now - at < HOUR);
    if (d.reads.length >= RECONCILE_MAX_READS_PER_HOUR) {
      d.nextAt = d.reads[0] + HOUR; await this.persist(now); fail('MERGE_RECONCILE_API_BUDGET');
    }
    d.reads.push(now); await this.persist(now);
    let result;
    try { result = await this.run(argv, { timeoutMs: 20_000 }); } catch { result = null; }
    return { result, reply: responseOf(result) };
  }
  async step() {
    if (this.busy) return { skipped: 'BUSY' };
    this.busy = true;
    try { return await this.stepOnce(); }
    catch (e) { return { skipped: e?.code ?? 'STATE_OR_READ_FAILURE', pending: this.state.data.pending !== null }; }
    finally { this.busy = false; }
  }
  async stepOnce() {
    const now = this.clock(), d = this.state.data;
    validateState(d, this.state.expected);
    if (!time(now) || now < d.lastTickAt) return { skipped: 'CLOCK_BACKWARD_OR_INVALID', pending: d.pending !== null };
    const off = await this.held(); if (off) return { skipped: 'NOT_ON_DUTY', reason: off };
    if (now < d.nextAt) return { skipped: 'NOT_DUE', retryAt: d.nextAt, pending: d.pending !== null };
    const source = await this.read(reconcileSourceArgv(this.ghExe, this.repo));
    if (!sourceMatches(source.reply, this.pinnedSource)) return this.failed(source.reply?.status === 429 ? 'RATE_LIMITED' : 'SOURCE_MISMATCH', source.result);
    const listed = await this.read(reconcileRunsArgv(this.ghExe, this.repo));
    const runs = runsOf(listed.reply);
    if (runs === null) return this.failed(listed.reply?.status === 429 ? 'RATE_LIMITED' : 'RUNS_UNREADABLE', listed.result);
    // Absence from this bounded list never proves an unknown POST did not
    // execute. A pending intent survives indefinitely until positive evidence.
    if (d.pending) {
      const seen = runs.find(r => r.event === 'workflow_dispatch' && r.title === `clued-merge-reconcile ${d.pending.requestId}`);
      d.nextAt = now + RECONCILE_EVERY_MS;
      if (!seen) {
        d.pending.phase = 'UNKNOWN'; d.lastCode = 'DISPATCH_UNKNOWN'; await this.persist(now); await this.notifyOnce('DISPATCH_UNKNOWN');
        return { skipped: 'DISPATCH_UNKNOWN', requestId: d.pending.requestId, pending: true };
      }
      const requestId = d.pending.requestId, requestedAt = d.pending.at;
      d.pending = null; d.failures = 0; d.lastCode = null; d.lastNotice = null; await this.persist(now);
      // Delivery acknowledgement is not another full cadence delay. The next
      // lane pass may wake again once five minutes from the original intent
      // have elapsed (subject to fresh Source, live holds, runs and budgets).
      d.nextAt = Math.max(now, requestedAt + RECONCILE_EVERY_MS); await this.persist(now);
      return { observed: true, requestId, runId: seen.id, runStatus: seen.status, pending: false };
    }
    // Another node's wake-up or a still-running controller is sufficient.
    // Neither this run list nor local state is a PR authorization cache.
    if (runs.some(r => r.status !== 'completed')) {
      d.nextAt = now + RECONCILE_EVERY_MS; await this.persist(now); return { skipped: 'RUN_PENDING' };
    }
    const recent = runs.some(r => r.at > now || now - r.at < RECONCILE_EVERY_MS);
    if (recent) { d.nextAt = now + RECONCILE_EVERY_MS; await this.persist(now); return { skipped: 'RECENT_RUN' }; }
    d.dispatches = d.dispatches.filter(at => now - at < HOUR);
    if (d.dispatches.length >= RECONCILE_MAX_DISPATCHES_PER_HOUR) {
      d.nextAt = d.dispatches[0] + HOUR; await this.persist(now); return { skipped: 'DISPATCH_BUDGET', retryAt: d.nextAt };
    }
    // Recheck both the public local hold and exact remote Source immediately
    // before recording the intent. The workflow rechecks all actual authority.
    const changed = await this.held(); if (changed) return { skipped: 'NOT_ON_DUTY', reason: changed };
    const finalSource = await this.read(reconcileSourceArgv(this.ghExe, this.repo));
    if (!sourceMatches(finalSource.reply, this.pinnedSource)) return this.failed(finalSource.reply?.status === 429 ? 'RATE_LIMITED' : 'SOURCE_MISMATCH', finalSource.result);
    const finalOff = await this.held(); if (finalOff) return { skipped: 'NOT_ON_DUTY', reason: finalOff };
    const sentAt = this.clock();
    if (sentAt < d.lastTickAt) fail('MERGE_RECONCILE_CLOCK_BACKWARD');
    const requestId = randomUUID();
    const newestRun = runs.reduce((newest, run) => Math.max(newest, run.id), 0);
    const dispatch = await dispatchByTrainEffect(this,
      { repo: this.repo, ref: RECONCILE_REF, subject: [RECONCILE_WORKFLOW, newestRun], requestId },
      async () => {
        d.pending = { requestId, at: sentAt, sourceSha256: this.pinnedSource, phase: 'INTENT' };
        d.dispatches.push(sentAt); d.nextAt = sentAt + RECONCILE_EVERY_MS;
        await this.persist(sentAt); // failure here is a hard zero-POST boundary
        try { return await this.run(reconcileDispatchArgv(this.ghExe, this.repo, requestId), { timeoutMs: 30_000 }); } catch { return null; }
      });
    if (!dispatch.sent) {
      d.nextAt = sentAt + RECONCILE_EVERY_MS; await this.persist(sentAt);
      return { skipped: 'SHARED_EFFECT_HELD' };
    }
    const sent = dispatch.reply;
    const reply = responseOf(sent);
    if (reply?.status === 204 && sent?.code === 0) {
      d.pending.phase = 'ACCEPTED'; d.lastCode = null; d.failures = 0; await this.persist(this.clock());
      return { dispatched: true, requestId, pending: true };
    }
    if (includes([400, 401, 403, 404, 405, 422, 429], reply?.status)) {
      d.pending = null;
      return this.failed(reply.status === 429 ? 'RATE_LIMITED' : 'DISPATCH_REFUSED', sent);
    }
    d.pending.phase = 'UNKNOWN';
    return this.failed('DISPATCH_UNKNOWN', sent);
  }
}
