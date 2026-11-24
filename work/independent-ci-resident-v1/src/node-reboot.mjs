// The node reboot fallback (docs/architecture.md 9.1; design D:/w/tmp/FABLE-admission-reboot-batch-20261124.md section 4, board
// row 140). Kernel objects some process leaks are freed only when the whole machine restarts; nothing on a node could restart it
// while nobody is there. This lane of the companion measures the largest paged pool tag (whatever its name), and once it is over a
// line it waits for the node to be idle, holds new batches, restarts the machine with one fixed shutdown.exe command and, after the
// restart, checks that the node came back. It is a helper (V15): when it cannot do something it does nothing, it never holds the node
// longer than two hours, and it never touches a HALT (V9).
//
//   soft line (3 GiB): wait for a natural idle window, a person away for 30 minutes included, then restart;
//   hard line (5 GiB): hold new batches at once and restart as soon as CI is idle, whether a person is using the machine or not.
//
// Idle (all of it, held for 10 minutes): the executor's status is fresh, no batch runs, no HALT, no PAUSE; no upgrade in flight
// (status.json `versions.upgrade`, the upgrade mailbox); no Runner.Worker on Windows or in the node's distribution (an unreadable
// read is not idle); soft line only: no input for 30 minutes; and at least six hours since this lane last restarted the node.
//
// Drain and restart: a create-only intent record, an intake pause (holder node-reboot, 30 minutes, renewed), items 1 to 3 read three
// times 20 s apart, `shutdown.exe /r /t 60` (600 on the hard line while a person uses the machine). Every 5 s of the countdown it looks
// again; a Runner.Worker, a batch or an upgrade aborts it (`shutdown.exe /a`), and it starts again from the three reads 5 minutes
// later. A pause of this lane never lasts more than two hours: then it is lifted, NODE_REBOOT_FAILED is notified once and nothing is
// tried for six hours. After the restart (an open intent and a later boot) it checks the node for up to 15 minutes, writes
// node-reboot-verified or node-reboot-check-failed and lifts its pause. A first reading still at half the soft line or more means the
// restart did not reclaim anything: the lane switches itself off for good (NODE_REBOOT_INEFFECTIVE).
//
// Before anything it reports whether it can work at all: SeShutdownPrivilege in its own token, and started by the supervisor in
// session 0. Without either it reports NODE_REBOOT_UNAVAILABLE with the reason and never does anything (no retry, no notification).
//
// Its records live in the companion's own profile (<profile>\AppData\Local\CluedIndependentCI\node-reboot\): availability.json and
// state.json (replaced whole), intent-<id>.json and close-<id>.json (create-only). Nothing here reads a tag's name to decide.
import fs from 'node:fs/promises';
import path from 'node:path';
import { check } from './canonical.mjs';
import { shutdownArgvOk } from './companion.mjs';
import { intakePauseRequest, intakeResumeRequest } from './intake-pause.mjs';
import { STATUS_STALE_MS } from './status.mjs';
import { UPGRADE_OUTCOMES } from './upgrade-mailbox.mjs';

export const NODE_REBOOT_HOLDER = 'node-reboot';
export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;
// companion.json `nodeReboot` (optional; U class): { enabled, softBytes, hardBytes }. The one definition of the lines.
export const NODE_REBOOT_DEFAULTS = Object.freeze({ enabled: true, softBytes: 3 * GIB, hardBytes: 5 * GIB });
export function validateNodeRebootConfig(v) {
  if (v === undefined || v === null) return NODE_REBOOT_DEFAULTS;
  check(typeof v === 'object' && !Array.isArray(v), 'COMPANION_NODE_REBOOT_CONFIG_INVALID');
  check(Object.keys(v).every(k => ['enabled', 'softBytes', 'hardBytes'].includes(k)), 'COMPANION_NODE_REBOOT_CONFIG_INVALID');
  const c = { ...NODE_REBOOT_DEFAULTS, ...v };
  check(typeof c.enabled === 'boolean', 'COMPANION_NODE_REBOOT_CONFIG_INVALID');
  for (const k of ['softBytes', 'hardBytes']) check(Number.isSafeInteger(c[k]) && c[k] >= MIB && c[k] <= 256 * GIB, 'COMPANION_NODE_REBOOT_CONFIG_INVALID');
  check(c.softBytes < c.hardBytes, 'COMPANION_NODE_REBOOT_CONFIG_INVALID');
  return Object.freeze(c);
}

const MIN = 60_000, HOUR = 60 * MIN;
export const NODE_REBOOT_STEP_MS = 5_000;          // the lane's period (and the countdown's look)
export const MEASURE_EVERY_MS = 10 * MIN;
export const OVER_READS = 2;                       // consecutive readings over a line before it counts
export const IDLE_CHECK_EVERY_MS = MIN;
export const IDLE_HOLD_MS = 10 * MIN;
export const HUMAN_AWAY_MS = 30 * MIN;
export const REBOOT_GAP_MS = 6 * HOUR;
export const PAUSE_MINUTES = 30;
export const PAUSE_RENEW_MS = 20 * MIN;
export const CONFIRM_READS = 3;
export const CONFIRM_GAP_MS = 20_000;
export const DELAY_S = 60;
export const DELAY_PERSON_S = 600;
export const COUNTDOWN_LOOK_MS = 5_000;
export const RETRY_AFTER_MS = 5 * MIN;
export const COUNTDOWN_GRACE_MS = 5 * MIN;         // still running this long after the countdown: the restart did not take
export const PAUSE_CAP_MS = 2 * HOUR;
export const FAIL_BACKOFF_MS = 6 * HOUR;
export const VERIFY_WINDOW_MS = 15 * MIN;
export const VERIFY_EVERY_MS = MIN;
export const CANCELS_KEPT = 20;
export const CODES = Object.freeze({ UNAVAILABLE: 'NODE_REBOOT_UNAVAILABLE', FAILED: 'NODE_REBOOT_FAILED', CHECK_FAILED: 'NODE_REBOOT_CHECK_FAILED',
  INEFFECTIVE: 'NODE_REBOOT_INEFFECTIVE' });
export const RECEIPT_VERIFIED = 'node-reboot-verified';
export const RECEIPT_CHECK_FAILED = 'node-reboot-check-failed';
export const POOL_TAGS_CONTRACT = 'clued.independent-ci.pool-tags/1';
export const NODE_REBOOT_STATE_CONTRACT = 'clued.independent-ci.node-reboot-state/1';
export const NODE_REBOOT_AVAILABILITY_CONTRACT = 'clued.independent-ci.node-reboot-availability/1';
export const NODE_REBOOT_INTENT_CONTRACT = 'clued.independent-ci.node-reboot-intent/1';
export const NODE_REBOOT_CLOSE_CONTRACT = 'clued.independent-ci.node-reboot-close/1';
export const SUPERVISOR_EXE = 'CluedCompanionSupervisor.exe';
export const nodeRebootDir = profileDir => path.join(profileDir, 'AppData', 'Local', 'CluedIndependentCI', 'node-reboot');

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const lastLine = s => String(s ?? '').trim().split(/\r?\n/).at(-1) ?? '';
const ran = r => !!r && r.code === 0 && !r.timedOut && !r.refused;

// ---- parsers of the fixed commands' output (companion.mjs argv) ----
// read-pool-tags.ps1: the largest paged tag { tag, bytes, count }, or null for anything not exactly its shape.
export function parsePoolTags(stdout) {
  let v;
  try { v = JSON.parse(lastLine(stdout)); } catch { return null; }
  if (!plain(v) || v.contract !== POOL_TAGS_CONTRACT || !Array.isArray(v.tags) || v.tags.length === 0 || v.tags.length > 65536) return null;
  let best = null;
  for (const t of v.tags) {
    if (!plain(t) || typeof t.tag !== 'string' || !/^[ -~]{1,4}$/.test(t.tag) || !Number.isSafeInteger(t.pagedBytes) || t.pagedBytes < 0
      || !Number.isSafeInteger(t.pagedCount) || t.pagedCount < 0) return null;
    if (best === null || t.pagedBytes > best.bytes) best = { tag: t.tag, bytes: t.pagedBytes, count: t.pagedCount };
  }
  return best;
}
// tasklist /FO CSV /NH: the image names (lower case), or null unless the list holds tasklist.exe itself (a list that does not show
// its own reader is no list). The header line is not printed and the rows are not localized.
export function parseTasklist(stdout) {
  const names = new Set();
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = /^"([^"]{1,260})","(\d{1,10})",/.exec(line);
    if (m) names.add(m[1].toLowerCase());
  }
  return names.has('tasklist.exe') ? names : null;
}
// quser: the shortest idle time of any session in ms, or null when no session row can be read. The header and the state are
// localized; the row is <user> [<session name>] <id> <state> <idle> <logon date and time>. The idle column is minutes, H:MM or
// D+H:MM; '.' or a word ("none", "无") is under a minute.
export function parseQuserIdleMs(stdout) {
  let least = null;
  const lines = String(stdout ?? '').split(/\r?\n/).filter(l => l.trim() !== '');
  for (const line of lines.slice(1)) {
    const tokens = line.replace(/^>/, ' ').trim().split(/\s+/);
    const at = tokens.findIndex((t, i) => i >= 1 && i <= 2 && /^\d{1,5}$/.test(t));
    if (at < 0 || tokens.length < at + 4) continue;
    const idle = tokens[at + 2];
    let ms;
    let m;
    if ((m = /^(\d{1,4})\+(\d{1,2}):(\d{2})$/.exec(idle))) ms = ((Number(m[1]) * 24 + Number(m[2])) * 60 + Number(m[3])) * MIN;
    else if ((m = /^(\d{1,2}):(\d{2})$/.exec(idle))) ms = (Number(m[1]) * 60 + Number(m[2])) * MIN;
    else if (/^\d{1,5}$/.test(idle)) ms = Number(idle) * MIN;
    else ms = 0;
    least = least === null ? ms : Math.min(least, ms);
  }
  return least;
}
// whoami /priv /fo csv /nh: the privilege names in the token (the description and state columns are localized), or null.
export function parsePrivileges(stdout) {
  const names = new Set();
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = /^"(Se[A-Za-z]{1,60}Privilege)",/.exec(line);
    if (m) names.add(m[1]);
  }
  return names.size > 0 ? names : null;
}
// argv.selfProcess: { session, parentName, parentPath } or null.
export function parseSelfProcess(stdout) {
  let v;
  try { v = JSON.parse(lastLine(stdout)); } catch { return null; }
  if (!plain(v) || !Number.isSafeInteger(v.session)) return null;
  return { session: v.session, parentName: typeof v.parentName === 'string' ? v.parentName : null, parentPath: typeof v.parentPath === 'string' ? v.parentPath : null };
}
// status.json `versions.upgrade`: an op that has not reached an outcome is in flight.
export const upgradeInFlight = u => plain(u) && typeof u.state === 'string' && !UPGRADE_OUTCOMES.includes(u.state);

const stamp = ms => new Date(ms).toISOString().replace(/[-:.]/g, '');
const ID = /^\d{8}T\d{9}Z$/;
const gib = b => `${(b / GIB).toFixed(2)} GiB`;

export class NodeReboot {
  // ports: { config (validateNodeRebootConfig) | null, a (companion.mjs argv(cfg)), run(argv, { timeoutMs }) -> { code, stdout, timedOut?,
  //   refused? }, root (the resident root: the supervisor is root\bin\CluedCompanionSupervisor.exe), dir (nodeRebootDir), clock(),
  //   uptimeMs() (this boot's age), pid (the companion's own), readStatus() -> parsed status.json (status.mjs#readStatus), upgradePending()
  //   -> boolean (a request in the upgrade mailbox), writeRequest(value) (an intake pause request into requests\), notify(key, title, body),
  //   heartbeatOk() -> boolean (the companion's own node heartbeat went out) }
  constructor(ports) {
    Object.assign(this, ports);
    this.phase = 'init';
    this.state = null;
    this.nextMeasureAt = 0; this.over = 0; this.overHard = 0; this.reading = null;
    this.episode = null;    // { id, line, pauseSince, pausedAt, intent, idleSince, nextIdleAt, confirms, nextConfirmAt, retryAt, deadline }
    this.verifying = null;  // { intent, since, bootAt, nextAt, firstPool, failed }
  }

  // ---- ports with the lane's own guard ----
  async exec(argv, timeoutMs) {
    // shutdown.exe runs with one of its two fixed groups only (companion.mjs#shutdownArgvOk), whatever built the argv.
    if (Array.isArray(argv) && typeof argv[0] === 'string' && /(^|\\)shutdown\.exe$/i.test(argv[0]) && !shutdownArgvOk(argv)) return { code: null, stdout: '', refused: 'NODE_REBOOT_ARGV_REFUSED' };
    try { return await this.run(argv, { timeoutMs }); } catch { return { code: null, stdout: '', refused: 'NODE_REBOOT_RUN_FAILED' }; }
  }
  bootAt() { return this.clock() - this.uptimeMs(); }
  async pool() { const r = await this.exec(this.a.poolTags(), 120_000); return ran(r) ? parsePoolTags(r.stdout) : null; }
  async processes() { const r = await this.exec(this.a.tasklist(), 30_000); return ran(r) ? parseTasklist(r.stdout) : null; }
  async humanIdleMs() { const r = await this.exec(this.a.quser(), 30_000); return ran(r) ? parseQuserIdleMs(r.stdout) : null; }
  // A Runner.Worker in the distribution: true, false, or null (unreadable).
  async wslWorker() {
    const r = await this.exec(this.a.wslRunnerWorker(), 60_000);
    if (!r || r.timedOut || r.refused) return null;
    return r.code === 0 ? true : r.code === 1 ? false : null;
  }
  async status() { try { return await this.readStatus(); } catch { return null; } }

  // ---- records ----
  file(name) { return path.join(this.dir, name); }
  async writeWhole(name, value) {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = this.file(`${name}.${process.pid}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(value));
    await fs.rename(tmp, this.file(name));
  }
  async createOnly(name, value) { await fs.mkdir(this.dir, { recursive: true }); await fs.writeFile(this.file(name), JSON.stringify(value), { flag: 'wx' }); }
  async readJson(name) { try { return JSON.parse(await fs.readFile(this.file(name), 'utf8')); } catch { return null; } }
  async loadState() {
    const s = await this.readJson('state.json');
    const ok = plain(s) && s.contract === NODE_REBOOT_STATE_CONTRACT;
    this.state = { contract: NODE_REBOOT_STATE_CONTRACT, lastRebootAt: ok && Number.isSafeInteger(s.lastRebootAt) ? s.lastRebootAt : null,
      backoffUntil: ok && Number.isSafeInteger(s.backoffUntil) ? s.backoffUntil : null, disabled: ok && plain(s.disabled) ? s.disabled : null,
      command: ok && plain(s.command) ? s.command : null, cancels: ok && Array.isArray(s.cancels) ? s.cancels.slice(-CANCELS_KEPT) : [] };
  }
  async saveState() { try { await this.writeWhole('state.json', this.state); } catch { /* the next save */ } }
  // Intents without a close record, oldest first.
  async openIntents() {
    let names = [];
    try { names = await fs.readdir(this.dir); } catch { return []; }
    const closed = new Set(names.map(n => /^close-(.+)\.json$/.exec(n)?.[1]).filter(Boolean));
    const out = [];
    for (const n of names.sort()) {
      const id = /^intent-(.+)\.json$/.exec(n)?.[1];
      if (!id || closed.has(id) || !ID.test(id)) continue;
      const v = await this.readJson(n);
      if (plain(v) && v.contract === NODE_REBOOT_INTENT_CONTRACT && v.id === id && Number.isSafeInteger(v.at)) out.push(v);
    }
    return out;
  }
  async close(id, kind, facts = {}) {
    try { await this.createOnly(`close-${id}.json`, { contract: NODE_REBOOT_CLOSE_CONTRACT, id, kind, at: this.clock(), ...facts }); } catch { /* closed already */ }
  }

  // ---- the intake pause of this lane ----
  async pause(reason) {
    try { await this.writeRequest(intakePauseRequest({ holder: NODE_REBOOT_HOLDER, minutes: PAUSE_MINUTES, reason }, this.clock)); } catch { return false; }
    return true;
  }
  async lift(reason) {
    try { await this.writeRequest(intakeResumeRequest({ holder: NODE_REBOOT_HOLDER, reason }, this.clock)); } catch { /* it runs out by itself */ }
  }
  async notifyOnce(key, title, body) { try { await this.notify(key, title, body); } catch { /* a notice only */ } }

  // ---- one pass of the lane; never throws ----
  async step() {
    try { return await this.pass(); } catch { return this.phase; }
  }

  async pass() {
    const now = this.clock();
    switch (this.phase) {
      case 'init': return this.start();
      case 'unavailable': case 'disabled': return this.phase;
      case 'verify': return this.verifyStep(now);
      default: break;
    }
    // The pause of this lane is renewed while it is in force (the countdown included), and never kept past PAUSE_CAP_MS.
    const e = this.episode;
    if (e && e.pausedAt !== null && now - e.pausedAt >= PAUSE_RENEW_MS && now - e.pauseSince < PAUSE_CAP_MS) {
      if (await this.pause('node reboot: kernel pool over its line (renewed)')) e.pausedAt = now;
    }
    if (this.phase === 'countdown') return this.countdownStep(now);
    if (now >= this.nextMeasureAt) await this.measure(now);
    if (this.phase === 'watch') return this.watchStep(now);
    if (this.episode.pauseSince !== null && now - this.episode.pauseSince >= PAUSE_CAP_MS) return this.giveUp(now);
    if (this.phase === 'armed') return this.armedStep(now);
    if (this.phase === 'confirm' && now >= this.episode.nextConfirmAt) return this.confirmStep(now);
    if (this.phase === 'retry' && now >= this.episode.retryAt) { this.phase = 'confirm'; this.episode.confirms = 0; this.episode.nextConfirmAt = now; return this.confirmStep(now); }
    return this.phase;
  }

  // The self-report first (no privilege or not the supervisor's child in session 0: nothing, ever), then a restart's check.
  async start() {
    const now = this.clock();
    const report = await this.availability();
    try { await this.writeWhole('availability.json', { contract: NODE_REBOOT_AVAILABILITY_CONTRACT, at: now, ...report }); } catch { /* the report only */ }
    if (!report.available) return (this.phase = 'unavailable');
    await this.loadState();
    if (this.state.disabled) return (this.phase = 'disabled');
    const open = await this.openIntents();
    const bootAt = this.bootAt();
    const latest = open.at(-1) ?? null;
    for (const i of open.slice(0, -1)) await this.close(i.id, 'superseded');
    if (latest && bootAt > latest.at) {
      // The machine started after the intent was written: check the node now.
      const command = this.state.command?.id === latest.id ? this.state.command : null;
      this.state.lastRebootAt = bootAt; this.state.command = null;
      await this.saveState();
      this.verifying = { intent: latest, since: now, bootAt, command, nextAt: now, firstPool: undefined, failed: [] };
      return (this.phase = 'verify');
    }
    if (latest) {
      // The companion restarted in the same boot while an episode was open: a pending restart is aborted (nobody watches its
      // countdown now) and the episode ends; the measurements start over.
      if (this.state.command?.id === latest.id) await this.exec(this.a.rebootAbort(), 30_000);
      this.state.command = null;
      await this.saveState();
      await this.close(latest.id, 'companion-restarted');
      await this.lift('node reboot: the companion restarted');
    } else {
      // A hold of this lane from before a companion restart, without an intent (the hard line's early pause): lift it.
      const s = await this.status();
      if (s?.intakePause?.holders?.some(h => h.holder === NODE_REBOOT_HOLDER)) await this.lift('node reboot: the companion restarted');
    }
    this.nextMeasureAt = now;
    return (this.phase = 'watch');
  }

  async availability() {
    if (!this.config) return { available: false, code: CODES.UNAVAILABLE, reason: 'CONFIG_INVALID' };
    if (!this.config.enabled) return { available: false, code: CODES.UNAVAILABLE, reason: 'DISABLED_BY_CONFIG' };
    const r = await this.exec(this.a.whoamiPriv(), 30_000);
    const privileges = ran(r) ? parsePrivileges(r.stdout) : null;
    const s = await this.exec(this.a.selfProcess(this.pid), 60_000);
    const self = ran(s) ? parseSelfProcess(s.stdout) : null;
    const supervisor = path.join(this.root, 'bin', SUPERVISOR_EXE).toLowerCase();
    const idle = await this.humanIdleMs();
    const facts = { shutdownPrivilege: privileges ? privileges.has('SeShutdownPrivilege') : null, session: self?.session ?? null,
      supervised: self ? (self.parentName ?? '').toLowerCase() === SUPERVISOR_EXE.toLowerCase() && (self.parentPath ?? '').toLowerCase() === supervisor : null,
      humanIdleReadable: idle !== null };
    let reason = null;
    if (privileges === null) reason = 'PRIVILEGES_UNREADABLE';
    else if (!facts.shutdownPrivilege) reason = 'NO_SHUTDOWN_PRIVILEGE';
    else if (self === null) reason = 'SELF_UNREADABLE';
    else if (self.session !== 0) reason = 'NOT_SESSION_0';
    else if (!facts.supervised) reason = 'NOT_STARTED_BY_SUPERVISOR';
    return { available: reason === null, code: reason === null ? null : CODES.UNAVAILABLE, reason, ...facts };
  }

  // One reading every MEASURE_EVERY_MS: the streaks over each line. A reading that fails or does not fit counts as nothing and ends
  // both streaks (nothing is done on it).
  async measure(now) {
    this.nextMeasureAt = now + MEASURE_EVERY_MS;
    const p = await this.pool();
    this.reading = p;
    if (!p) { this.over = 0; this.overHard = 0; return; }
    this.over = p.bytes >= this.config.softBytes ? this.over + 1 : 0;
    this.overHard = p.bytes >= this.config.hardBytes ? this.overHard + 1 : 0;
    if (this.phase === 'armed' && this.over === 0) {
      // Under the soft line again before anything was written: the episode ends.
      if (this.episode.pauseSince !== null) await this.lift('node reboot: kernel pool under its line');
      this.episode = null;
      this.phase = 'watch';
    }
    if (this.episode && this.overHard >= OVER_READS && this.episode.line !== 'hard') {
      this.episode.line = 'hard';
      if (this.episode.pauseSince === null && await this.pause('node reboot: kernel pool over the hard line')) { this.episode.pauseSince = now; this.episode.pausedAt = now; }
    }
  }
  level() { return this.overHard >= OVER_READS ? 'hard' : this.over >= OVER_READS ? 'soft' : null; }
  gapOk(now) { return this.state.lastRebootAt === null || now - this.state.lastRebootAt >= REBOOT_GAP_MS; }

  async watchStep(now) {
    const line = this.level();
    if (!line || (this.state.backoffUntil !== null && now < this.state.backoffUntil) || !this.gapOk(now)) return this.phase;
    this.episode = { id: stamp(now), line, pauseSince: null, pausedAt: null, intent: null, idleSince: null, nextIdleAt: now, confirms: 0, nextConfirmAt: 0, retryAt: 0, deadline: 0 };
    if (line === 'hard' && await this.pause('node reboot: kernel pool over the hard line')) { this.episode.pauseSince = now; this.episode.pausedAt = now; }
    this.phase = 'armed';
    return this.armedStep(now);
  }

  // Items 1 to 3 of the idle rule: null when idle, else what is not.
  async busy() {
    const s = await this.status();
    if (!s) return 'status-unreadable';
    if (!(this.clock() - s.writtenAt <= STATUS_STALE_MS)) return 'status-stale';
    if (s.halt || s.executor?.state === 'HALTED') return 'halt';
    if (s.paused || s.executor?.state === 'PAUSED') return 'paused';
    if (s.current || (s.pending ?? []).some(p => p.state === 'RUNNING')) return 'batch';
    if (upgradeInFlight(s.versions?.upgrade)) return 'upgrade';
    let pending;
    try { pending = await this.upgradePending(); } catch { pending = null; }
    if (pending !== false) return pending === true ? 'upgrade' : 'upgrade-unreadable';
    const names = await this.processes();
    if (!names) return 'process-table-unreadable';
    if (names.has('runner.worker.exe')) return 'runner-worker';
    const w = await this.wslWorker();
    if (w === null) return 'wsl-unreadable';
    if (w) return 'runner-worker-wsl';
    return null;
  }

  async armedStep(now) {
    const e = this.episode;
    if (now < e.nextIdleAt) return this.phase;
    e.nextIdleAt = now + IDLE_CHECK_EVERY_MS;
    let idle = this.gapOk(now) && (await this.busy()) === null;
    if (idle && e.line !== 'hard') { const ms = await this.humanIdleMs(); idle = ms !== null && ms >= HUMAN_AWAY_MS; }
    if (!idle) { e.idleSince = null; return this.phase; }
    e.idleSince ??= now;
    if (now - e.idleSince < IDLE_HOLD_MS) return this.phase;
    // Drain step 1: the create-only intent, then the pause (or its renewal).
    const s = await this.status();
    e.intent = { contract: NODE_REBOOT_INTENT_CONTRACT, id: e.id, at: now, bootAt: this.bootAt(), line: e.line, reading: this.reading,
      generation: s?.versions?.generation ?? null, source: s?.node?.source ?? null };
    try { await this.createOnly(`intent-${e.id}.json`, e.intent); } catch { e.idleSince = null; return this.phase; }
    if (await this.pause(`node reboot: kernel pool over the ${e.line} line, restarting when idle`)) { e.pauseSince ??= now; e.pausedAt = now; }
    this.phase = 'confirm'; e.confirms = 0; e.nextConfirmAt = now;
    return this.confirmStep(now);
  }

  async confirmStep(now) {
    const e = this.episode;
    if ((await this.busy()) !== null) return this.retry(now);
    e.confirms += 1;
    if (e.confirms < CONFIRM_READS) { e.nextConfirmAt = now + CONFIRM_GAP_MS; return this.phase; }
    let delayS = DELAY_S;
    if (e.line === 'hard') { const ms = await this.humanIdleMs(); if (ms === null || ms < HUMAN_AWAY_MS) delayS = DELAY_PERSON_S; }
    const r = await this.exec(this.a.reboot(delayS), 30_000);
    if (!ran(r)) return this.retry(now);
    this.state.command = { id: e.id, at: now, delayS };
    await this.saveState();
    e.deadline = now + delayS * 1000;
    return (this.phase = 'countdown');
  }

  retry(now) { this.episode.retryAt = now + RETRY_AFTER_MS; this.episode.confirms = 0; return (this.phase = 'retry'); }

  // During the countdown: a Runner.Worker, a batch or an upgrade (or a read that cannot tell) aborts the restart.
  async countdownStep(now) {
    const e = this.episode;
    if (now >= e.deadline) {
      if (now < e.deadline + COUNTDOWN_GRACE_MS) return this.phase;
      // Still here: the restart did not happen. From the three reads again (the two hours still bound the pause).
      this.state.command = null; await this.saveState();
      return this.retry(now);
    }
    const why = await this.busy();
    if (why === null) return this.phase;
    await this.exec(this.a.rebootAbort(), 30_000);
    this.state.command = null;
    this.state.cancels = [...this.state.cancels, { at: now, id: e.id, why, kind: 'work-arrived' }].slice(-CANCELS_KEPT);
    await this.saveState();
    return this.retry(now);
  }

  async giveUp(now) {
    const e = this.episode;
    await this.lift('node reboot: gave up for six hours');
    if (e.intent) await this.close(e.id, 'gave-up');
    this.state.backoffUntil = now + FAIL_BACKOFF_MS;
    await this.saveState();
    await this.notifyOnce(`node-reboot-failed:${e.id}`, '节点自动重启没做成',
      `内核池最大标签${this.reading ? `（${this.reading.tag} ${gib(this.reading.bytes)}）` : ''}已过线，但 2 小时内没等到空闲或重启命令没生效。已撤掉暂停接新，6 小时内不再试（${CODES.FAILED}）。`);
    this.episode = null; this.over = 0; this.overHard = 0;
    return (this.phase = 'watch');
  }

  // After the restart: every VERIFY_EVERY_MS for at most VERIFY_WINDOW_MS, each item read again.
  async verifyStep(now) {
    const v = this.verifying;
    if (now < v.nextAt) return this.phase;
    v.nextAt = now + VERIFY_EVERY_MS;
    const p = await this.pool();
    if (p && v.firstPool === undefined) {
      v.firstPool = p;
      if (p.bytes >= this.config.softBytes / 2) {
        this.state.disabled = { code: CODES.INEFFECTIVE, at: now, id: v.intent.id };
        await this.saveState();
        await this.close(v.intent.id, RECEIPT_CHECK_FAILED, { code: CODES.INEFFECTIVE, bootAt: v.bootAt, before: v.intent.reading, after: p });
        await this.lift('node reboot: the restart did not reclaim the pool');
        await this.notifyOnce(`node-reboot-ineffective:${v.intent.id}`, '节点重启没有回收内核池',
          `重启后第一次读数 ${p.tag} ${gib(p.bytes)}，仍不低于软线的一半。本节点的自动重启已停用（${CODES.INEFFECTIVE}）。`);
        return (this.phase = 'disabled');
      }
    }
    const failed = [];
    const s = await this.status();
    if (!s || !(this.clock() - s.writtenAt <= STATUS_STALE_MS) || s.node?.mode === 'UNCERTAIN') failed.push('executor');
    if (!s || s.halt || s.executor?.state === 'HALTED') failed.push('halt');
    if (!s || (s.versions?.generation ?? null) !== v.intent.generation || (s.node?.source ?? null) !== v.intent.source) failed.push('version');
    const names = await this.processes();
    if (!names || !names.has('runner.listener.exe')) failed.push('runner-listener');
    if (!ran(await this.exec(this.a.wslUp(), 120_000))) failed.push('wsl');
    let beat = false;
    try { beat = (await this.heartbeatOk()) === true; } catch { beat = false; }
    if (!beat || s?.executor?.companion?.firstBeatAfterServiceStartMs === null || s?.executor?.companion?.firstBeatAfterServiceStartMs === undefined) failed.push('heartbeat');
    if (!p || p.bytes >= this.config.softBytes / 4) failed.push('pool');
    v.failed = failed;
    // downMs: from the end of the countdown (the restart) to this check; null when the restart was not this lane's command.
    const facts = { bootAt: v.bootAt, commandAt: v.command?.at ?? null, downMs: v.command ? now - (v.command.at + v.command.delayS * 1000) : null, before: v.intent.reading, after: p };
    if (failed.length === 0) {
      await this.close(v.intent.id, RECEIPT_VERIFIED, facts);
      await this.lift('node reboot: verified');
      return this.afterVerify(now);
    }
    if (now - v.since < VERIFY_WINDOW_MS) return this.phase;
    await this.close(v.intent.id, RECEIPT_CHECK_FAILED, { ...facts, failed });
    await this.lift('node reboot: checked after the restart');
    await this.notifyOnce(`node-reboot-check-failed:${v.intent.id}`, '节点重启后自检未过',
      `重启后 15 分钟内这几项没过：${failed.join('、')}。已撤掉暂停接新；节点自己的启动把关（UNCERTAIN、HALT）照常负责安全（${CODES.CHECK_FAILED}）。`);
    return this.afterVerify(now);
  }
  afterVerify(now) {
    this.verifying = null; this.episode = null; this.over = 0; this.overHard = 0;
    this.nextMeasureAt = now;
    return (this.phase = 'watch');
  }
}
