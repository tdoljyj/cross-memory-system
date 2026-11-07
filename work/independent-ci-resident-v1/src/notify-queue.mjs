// The companion's notifications go through a queue (DESIGN §65.4.3, M5): the companion runs in session 0 under a password logon
// (no desktop), so it never shows a toast itself. Each of its six notification sites calls notify(key, title, body), which writes
// one create-only file into %LOCALAPPDATA%\CluedIndependentCI\notify-queue\ of the Owner's profile. The notifier task
// (\Clued\CluedCIResidentNotifier, notifier-main.mjs: the Owner's interactive token, at log-on) shows them and deletes them.
//
// The queue is the Owner's own directory: any process of the Owner's session can write it, exactly as any process of that session
// can show a toast today. So a queued text is never trusted for anything, and the notifier never shows a text that asks for a
// password or a credential (suspiciousText): Clued never asks for one in a notification; the runbook says a password is typed only
// into the Windows credential box on the secure desktop, after the Owner started the elevated command himself.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const NOTIFY_CONTRACT = 'clued.independent-ci.notify/1';
export const NOTIFY_QUEUE_DIR = 'notify-queue';
export const NOTIFY_MAX_FILES = 500;
export const NOTIFY_MAX_BYTES = 2 * 1024 * 1024;
export const NOTIFY_TEXT_MAX = 400;   // toastArgv clips each text to 400 characters as well
export const NOTIFY_FILE_MAX = 8192;
export const NOTIFY_KEY_MAX = 160;
const NAME = /^(\d{13})-([0-9a-f]{12})\.json$/;
export const DROPPED_KEY = 'notify-queue-dropped';

// %LOCALAPPDATA%\CluedIndependentCI\notify-queue of the Owner's profile (the node profile's ownerProfileDirectory).
export const notifyQueueDir = profileDir => path.join(profileDir, 'AppData', 'Local', 'CluedIndependentCI', NOTIFY_QUEUE_DIR);
const clip = (s, n) => String(s ?? '').slice(0, n);

// A text that asks for a password or credential is never shown as it is (a forged queue entry; DESIGN §65.4.3, T8).
// A request to type, give or confirm a password or credential (either word order); a mention alone (for example "令牌没有问题") is
// not one, so today's texts pass unchanged.
const SECRET_WORD = '(?:密码|口令|凭据|凭证|password|passwd|passphrase|passcode|credentials?|PIN\\b)';
const ASK_WORD = '(?:输入|填写|填入|键入|提供|告诉|发送|粘贴|确认|验证|enter|type|provide|paste|submit|confirm|verify|re-?enter)';
const SUSPICIOUS = new RegExp(`${ASK_WORD}[^。.!！?？\\n]{0,24}${SECRET_WORD}|${SECRET_WORD}[^。.!！?？\\n]{0,24}${ASK_WORD}`, 'i');
export function suspiciousText(...texts) { return texts.some(t => SUSPICIOUS.test(String(t ?? ''))); }
export const SUSPICIOUS_TITLE = 'Clued：拦下一条可疑通知';
export const SUSPICIOUS_BODY = '这条通知的内容提到了密码或凭据，已丢弃。Clued 从不在通知里要求输入密码；只在你自己启动的提权命令里、安全桌面上的 Windows 凭据框中输入（运维手册 M5 第 0 节）。';

export class NotifyQueue {
  constructor({ dir, clock = Date.now, fsImpl = fs, nonce = () => randomBytes(6).toString('hex') }) {
    this.dir = dir; this.clock = clock; this.fs = fsImpl; this.nonce = nonce;
  }

  // The files in queue order (oldest first), with their sizes; other names are left alone.
  async list() {
    let names;
    try { names = await this.fs.readdir(this.dir); } catch { return []; }
    const out = [];
    for (const name of names.filter(n => NAME.test(n)).sort()) {
      try { const st = await this.fs.lstat(path.join(this.dir, name)); if (st.isFile()) out.push({ name, size: st.size }); } catch { /* gone */ }
    }
    return out;
  }

  async write(entry) {
    const now = this.clock();
    const name = `${String(now).padStart(13, '0')}-${this.nonce()}.json`;
    await this.fs.writeFile(path.join(this.dir, name), JSON.stringify(entry), { flag: 'wx' });
    return name;
  }

  // One notification. The key is only for the reader (the "already queued" memory lives with the caller, as "already notified" did).
  // Returns { queued, dropped }. Never throws for a full queue: the oldest files go first, then one line says how many went.
  async notify(key, title, body) {
    await this.fs.mkdir(this.dir, { recursive: true });
    const at = new Date(this.clock()).toISOString();
    const mine = await this.write({ contract: NOTIFY_CONTRACT, key: clip(key, NOTIFY_KEY_MAX), title: clip(title, NOTIFY_TEXT_MAX), body: clip(body, NOTIFY_TEXT_MAX), at });
    const dropped = await this.bound(mine);
    if (dropped > 0) {
      await this.write({ contract: NOTIFY_CONTRACT, key: DROPPED_KEY, title: 'Clued：通知队列已满', body: `已丢弃 ${dropped} 条较早的通知（队列上限 ${NOTIFY_MAX_FILES} 条、2 MB）。`, at });
    }
    return { queued: true, dropped };
  }

  // Keeps at most NOTIFY_MAX_FILES - 1 files and NOTIFY_MAX_BYTES - NOTIFY_FILE_MAX bytes (room for the "dropped" line), removing
  // the oldest first; the file just written is the last one removed.
  async bound(mine) {
    const files = await this.list();
    let count = files.length, bytes = files.reduce((a, f) => a + f.size, 0), dropped = 0;
    for (const f of files) {
      if (count <= NOTIFY_MAX_FILES - 1 && bytes <= NOTIFY_MAX_BYTES - NOTIFY_FILE_MAX) break;
      if (f.name === mine && count > 1) continue;
      try { await this.fs.rm(path.join(this.dir, f.name), { force: true }); } catch { continue; }
      count -= 1; bytes -= f.size; dropped += 1;
    }
    return dropped;
  }

  // The notifier's side: at most `max` entries, oldest first. Each file is read once (bounded), deleted, then shown with show(title,
  // body); a file that does not parse is deleted unseen. A text that asks for a credential is replaced by a fixed warning.
  async drain(show, { max = 5 } = {}) {
    let shown = 0;
    for (const f of await this.list()) {
      if (shown >= max) break;
      const file = path.join(this.dir, f.name);
      let entry = null;
      try {
        if (f.size <= NOTIFY_FILE_MAX) entry = parseEntry(await this.fs.readFile(file, 'utf8'));
      } catch { entry = null; }
      try { await this.fs.rm(file, { force: true }); } catch { continue; }   // never shown twice
      if (!entry) continue;
      const safe = suspiciousText(entry.title, entry.body) ? { title: SUSPICIOUS_TITLE, body: SUSPICIOUS_BODY } : entry;
      try { await show(safe.title, safe.body, entry.key); } catch { /* one toast */ }
      shown += 1;
    }
    return shown;
  }
}

export function parseEntry(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.contract !== NOTIFY_CONTRACT) return null;
  if (typeof v.key !== 'string' || typeof v.title !== 'string' || typeof v.body !== 'string') return null;
  return { key: clip(v.key, NOTIFY_KEY_MAX), title: clip(v.title, NOTIFY_TEXT_MAX), body: clip(v.body, NOTIFY_TEXT_MAX) };
}

// The six notification sites take (key, title, body) => Promise; this is that port over one queue (errors are the site's, as a
// failed toast was: the caller's memory decides whether it tries again).
export function queueNotify(queue) {
  return async (key, title, body) => { await queue.notify(key, title, body); return { code: 0 }; };
}

// ---- What the notifier checks itself (DESIGN §65.4.3): the companion task's last result, the heartbeat, the restarts ----
// LastTaskResult values that mean the password logon was refused. The task scheduler returns them as HRESULTs (0x8007xxxx).
export const LOGON_FAILURE_CODES = Object.freeze({
  '0x8007052E': '用户名或密码不对（多半是改了 Windows 密码）',
  '0x8007052F': '账户限制（例如空密码不允许登录）',
  '0x80070530': '不在允许登录的时段',
  '0x80070532': '密码已过期',
  '0x80070533': '账户已停用',
  '0x80070569': '没有“作为批处理作业登录”的权限',
  '0x80070775': '账户已被锁定',
});
// A COM LastTaskResult (a signed or unsigned 32-bit number) as 0xXXXXXXXX.
export function hresultHex(v) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < -0x80000000 || v > 0xFFFFFFFF) return null;
  return `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}
export function logonFailure(lastTaskResult) {
  const hex = hresultHex(lastTaskResult);
  return hex && Object.hasOwn(LOGON_FAILURE_CODES, hex) ? { code: hex, why: LOGON_FAILURE_CODES[hex] } : null;
}

export const HEARTBEAT_ABSENT_MS = 5 * 60_000;
export const RESTARTS_WINDOW_MS = 15 * 60_000;
export const RESTARTS_MAX = 5;
// The notifier's findings, pure: task { lastTaskResult, state } | null, heartbeatAt (ms) | null, exits [{ at }] (supervisor.json,
// informational), now. Each finding is { key, title, body }; the texts give a code and a runbook section, never a request for a password.
export function companionFindings({ task, heartbeatAt, exits = [], now }) {
  const out = [];
  const failure = task ? logonFailure(task.lastTaskResult) : null;
  if (failure) {
    out.push({ key: `companion-logon:${failure.code}`, title: `Clued：companion 无法登录（码 ${failure.code}）`,
      body: `${failure.why}。companion 没有运行。处理办法见运维手册 M5 第 4 节“改密码后重设”。` });
  }
  if (!failure && (heartbeatAt === null || now - heartbeatAt > HEARTBEAT_ABSENT_MS)) {
    out.push({ key: 'companion-no-heartbeat', title: 'Clued：companion 无心跳',
      body: `companion 已超过 ${Math.round(HEARTBEAT_ABSENT_MS / 60_000)} 分钟没有心跳，节点不会接新批次。见运维手册 M5 第 5 节“排查”。` });
  }
  const recent = (Array.isArray(exits) ? exits : []).filter(e => Number.isFinite(Date.parse(e?.at)) && now - Date.parse(e.at) <= RESTARTS_WINDOW_MS);
  if (recent.length >= RESTARTS_MAX) {
    out.push({ key: 'companion-restarting', title: 'Clued：companion 反复重启',
      body: `最近 15 分钟里 companion 退出了 ${recent.length} 次，监督进程在退避重启。见运维手册 M5 第 5 节“排查”。` });
  }
  return out;
}
