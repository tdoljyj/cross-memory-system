// The kernel pool alert (docs/architecture.md 9.1; board row 140, design D:/w/tmp/FABLE-admission-reboot-batch-20261124.md section 4
// as changed by the Owner on 11-24: "到线通知我 别擅自 自动重启"). Kernel objects some process leaks are freed only when the whole
// machine restarts. This lane of the companion measures the largest paged pool tag (whatever its name) every 10 minutes and, once it
// is over a line, tells the Owner through the notification queue (notify-queue.mjs) so he restarts the machine when it suits him.
// It never restarts, never shuts down, never pauses intake and never runs anything but windows/read-pool-tags.ps1.
//
//   soft line (3 GiB) and hard line (5 GiB), each counted after two consecutive readings over it;
//   one notice per line per episode (fixed, not configurable): an episode starts at the first line reached and ends after two
//   consecutive readings under the soft line; a soft notice is skipped when the hard one was already sent; a notice that could not
//   be queued is tried again at the next reading.
//
// The notice says: the paged pool in total and its largest tag, how much is left under the commit limit, the growth over the last
// hours of this boot and from it the hours to the hard line and to the commit limit, and when to restart (Beijing time).
// Its state lives in the companion's own profile (<profile>\AppData\Local\CluedIndependentCI\pool-alert\state.json, replaced whole),
// so a companion restart does not notify the same episode again.
import fs from 'node:fs/promises';
import path from 'node:path';
import { check } from './canonical.mjs';

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;
const MIN = 60_000, HOUR = 60 * MIN;
// companion.json `poolAlert` (optional; U class): { enabled, softBytes, hardBytes }. The one definition of the lines.
export const POOL_ALERT_DEFAULTS = Object.freeze({ enabled: true, softBytes: 3 * GIB, hardBytes: 5 * GIB });
export function validatePoolAlertConfig(v) {
  if (v === undefined || v === null) return POOL_ALERT_DEFAULTS;
  check(typeof v === 'object' && !Array.isArray(v), 'COMPANION_POOL_ALERT_CONFIG_INVALID');
  check(Object.keys(v).every(k => ['enabled', 'softBytes', 'hardBytes'].includes(k)), 'COMPANION_POOL_ALERT_CONFIG_INVALID');
  const c = { ...POOL_ALERT_DEFAULTS, ...v };
  check(typeof c.enabled === 'boolean', 'COMPANION_POOL_ALERT_CONFIG_INVALID');
  for (const k of ['softBytes', 'hardBytes']) check(Number.isSafeInteger(c[k]) && c[k] >= MIB && c[k] <= 256 * GIB, 'COMPANION_POOL_ALERT_CONFIG_INVALID');
  check(c.softBytes < c.hardBytes, 'COMPANION_POOL_ALERT_CONFIG_INVALID');
  return Object.freeze(c);
}

export const POOL_ALERT_EVERY_MS = 10 * MIN;       // the lane's period: one reading
export const OVER_READS = 2;                       // consecutive readings over a line before it counts
export const UNDER_READS = 2;                      // consecutive readings under the soft line end the episode
export const RATE_WINDOW_MS = 6 * HOUR;            // the growth is measured over the readings of this boot within this window
export const RATE_MIN_SPAN_MS = HOUR;              // and only when they span at least this long
export const READINGS_KEPT = 40;
export const BOOT_SKEW_MS = 5 * MIN;               // a boot time that moved more than this: a new boot, the old readings are dropped
export const READ_TIMEOUT_MS = 60_000;
export const CODES = Object.freeze({ soft: 'POOL_ALERT_SOFT', hard: 'POOL_ALERT_HARD' });
export const POOL_READING_CONTRACT = 'clued.independent-ci.pool-reading/1';
export const POOL_ALERT_STATE_CONTRACT = 'clued.independent-ci.pool-alert-state/1';
export const poolAlertDir = profileDir => path.join(profileDir, 'AppData', 'Local', 'CluedIndependentCI', 'pool-alert');

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const lastLine = s => String(s ?? '').trim().split(/\r?\n/).at(-1) ?? '';
const size = n => Number.isSafeInteger(n) && n >= 0;

// read-pool-tags.ps1: { tag, bytes, count, pagedPoolBytes, commitBytes, commitLimitBytes }, or null for anything not exactly its shape.
export function parsePoolReading(stdout) {
  let v;
  try { v = JSON.parse(lastLine(stdout)); } catch { return null; }
  if (!plain(v) || v.contract !== POOL_READING_CONTRACT || !plain(v.top)) return null;
  const t = v.top;
  if (typeof t.tag !== 'string' || !/^[ -~]{1,4}$/.test(t.tag) || !size(t.pagedBytes) || !size(t.pagedCount)) return null;
  if (!size(v.pagedPoolBytes) || !size(v.commitBytes) || !size(v.commitLimitBytes) || v.commitLimitBytes === 0) return null;
  return { tag: t.tag, bytes: t.pagedBytes, count: t.pagedCount, pagedPoolBytes: v.pagedPoolBytes, commitBytes: v.commitBytes,
    commitLimitBytes: v.commitLimitBytes };
}

// Bytes per ms over the readings of this boot within RATE_WINDOW_MS (oldest to newest), or null when they span under an hour.
export function growthRate(readings, now) {
  const r = readings.filter(x => x.at >= now - RATE_WINDOW_MS);
  if (r.length < 2) return null;
  const first = r[0], last = r.at(-1);
  const span = last.at - first.at;
  return span >= RATE_MIN_SPAN_MS ? { perMs: (last.bytes - first.bytes) / span, spanMs: span } : null;
}

const gib = b => `${(b / GIB).toFixed(2)} GiB`;
const hours = ms => `${(ms / HOUR).toFixed(1)} 小时`;
// Beijing time (UTC+8, no daylight saving): MM-DD HH:mm.
export const beijing = ms => new Date(ms + 8 * HOUR).toISOString().slice(5, 16).replace('T', ' ');

// The notice for one line (Chinese, under the queue's 400 characters).
export function alertText({ line, reading: p, rate, now, config, node = '' }) {
  const headroom = Math.max(0, p.commitLimitBytes - p.commitBytes);
  const growing = rate && rate.perMs > 0;
  const toHard = growing && p.bytes < config.hardBytes ? (config.hardBytes - p.bytes) / rate.perMs : null;
  const toCommit = growing ? headroom / rate.perMs : null;
  const who = node ? `${node} ` : '';
  const title = line === 'hard' ? `Clued：${who}内核池到硬线，请尽快重启` : `Clued：${who}内核池到软线，请安排重启`;
  const parts = [
    `分页池共 ${gib(p.pagedPoolBytes)}，最大标签 ${p.tag} ${gib(p.bytes)}（软线 ${gib(config.softBytes)}，硬线 ${gib(config.hardBytes)}）。`,
    `离提交上限还有 ${gib(headroom)}（已提交 ${gib(p.commitBytes)} / 上限 ${gib(p.commitLimitBytes)}）。`,
  ];
  if (growing) {
    parts.push(`近 ${hours(rate.spanMs)}增速约 ${gib(rate.perMs * HOUR)}/小时；按此增速`
      + (toHard !== null ? `约 ${hours(toHard)}到硬线（${beijing(now + toHard)}），` : '')
      + `约 ${hours(toCommit)}用完提交余量（${beijing(now + toCommit)}）。`);
  } else {
    parts.push(rate ? `近 ${hours(rate.spanMs)}没有增长，估不出到线时间。` : '本次开机的读数还不到 1 小时，估不出增速。');
  }
  const by = growing ? Math.min(toHard ?? Infinity, toCommit) : null;
  if (line === 'hard') parts.push(`建议：今天在 CI 空闲时尽快重启${toCommit !== null ? `，最迟 ${beijing(now + toCommit)}（北京时间）前` : ''}。`);
  else parts.push(by !== null ? `建议：在 ${beijing(now + by)}（北京时间）前找 CI 空闲时重启。` : '建议：下次方便时，在 CI 空闲时重启。');
  parts.push(`系统不会自动重启（${CODES[line]}）。`);
  return { title, body: parts.join('') };
}

// The lane. step() never throws; the only command it runs is a.poolTags().
export class PoolAlert {
  constructor({ config, a, run, dir, clock, uptimeMs, notify, node = '' }) {
    Object.assign(this, { config, a, run, dir, clock, uptimeMs, notify, node });
    this.state = null; this.over = 0; this.overHard = 0; this.under = 0;
  }

  async step() {
    try { await this.measure(); } catch { /* a helper: the next reading */ }
  }

  file() { return path.join(this.dir, 'state.json'); }
  async load() {
    let s = null;
    try { s = JSON.parse(await fs.readFile(this.file(), 'utf8')); } catch { /* none yet */ }
    const ok = plain(s) && s.contract === POOL_ALERT_STATE_CONTRACT;
    const episode = ok && plain(s.episode) && typeof s.episode.id === 'string' && plain(s.episode.notified) ? s.episode : null;
    this.state = { contract: POOL_ALERT_STATE_CONTRACT, bootAt: ok && Number.isSafeInteger(s.bootAt) ? s.bootAt : null,
      readings: ok && Array.isArray(s.readings) ? s.readings.filter(x => plain(x) && Number.isSafeInteger(x.at) && size(x.bytes)).slice(-READINGS_KEPT) : [],
      episode };
  }
  async save() {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = path.join(this.dir, `state.json.${process.pid}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(this.state));
      await fs.rename(tmp, this.file());
    } catch { /* the next save */ }
  }

  async measure() {
    if (!this.config || !this.config.enabled) return;
    if (this.state === null) await this.load();
    let r = null;
    try { r = await this.run(this.a.poolTags(), { timeoutMs: READ_TIMEOUT_MS }); } catch { r = null; }
    const p = r && r.code === 0 && !r.timedOut && !r.refused ? parsePoolReading(r.stdout) : null;
    if (!p) { this.over = 0; this.overHard = 0; this.under = 0; return; }   // no reading: nothing is decided
    const now = this.clock();
    const s = this.state;
    const bootAt = now - this.uptimeMs();
    if (s.bootAt === null || Math.abs(bootAt - s.bootAt) > BOOT_SKEW_MS) { s.bootAt = bootAt; s.readings = []; }
    s.readings = [...s.readings, { at: now, bytes: p.bytes }].filter(x => x.at >= now - RATE_WINDOW_MS).slice(-READINGS_KEPT);
    this.over = p.bytes >= this.config.softBytes ? this.over + 1 : 0;
    this.overHard = p.bytes >= this.config.hardBytes ? this.overHard + 1 : 0;
    this.under = p.bytes < this.config.softBytes ? this.under + 1 : 0;
    if (s.episode && this.under >= UNDER_READS) s.episode = null;
    const line = this.overHard >= OVER_READS ? 'hard' : this.over >= OVER_READS ? 'soft' : null;
    if (line) {
      if (!s.episode) s.episode = { id: new Date(now).toISOString().replace(/[-:.]/g, ''), startedAt: now, notified: {} };
      const due = line === 'hard' ? !s.episode.notified.hard : !s.episode.notified.soft && !s.episode.notified.hard;
      if (due) {
        const { title, body } = alertText({ line, reading: p, rate: growthRate(s.readings, now), now, config: this.config, node: this.node });
        try {
          await this.notify(`pool-alert:${line}:${s.episode.id}`, title, body);
          s.episode.notified = { ...s.episode.notified, [line]: now };
        } catch { /* not queued: the next reading tries again */ }
      }
    }
    await this.save();
  }
}
