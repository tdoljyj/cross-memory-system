// The companion's node heartbeat for ci-admission automatic take-over (merge train step 3c-2b, DESIGN §41.6a; Decision
// 199cf3de). The companion runs in the Owner's session and may reach the network; the service may not (§8). Every
// NODE_HEARTBEAT_EVERY_MS, whatever the train mode, PAUSE, HALT or a batch in flight, and at once when what it reports changed, it
// sends this node's self-report with the node's own heartbeat-only token (installed by -HeartbeatTokenFile into
// resident\secrets\heartbeat\, the Owner may read it). The server writes the time and binds the report to the token's node; the
// name in the payload is informational. No token installed: nothing here runs (CompanionHeartbeat.step answers NO_TOKEN).
//
// The wire (step 2b, migration 20261031090000_merge_train_failover_v1.sql, clued_private.ci_node_heartbeat_v1): the CI command
// door action ci_node_heartbeat, POST <supabase>/rest/v1/rpc/clued_work_verify_v1 { p_token_hash: sha256 hex of the token,
// p_input } with p_input exactly { action, scope (the installed record's), state, mode, probe, [intake_paused_until], halt,
// ci_source_manifest_sha256, service_running, snapshot_age_seconds, node_name } (heartbeatPayload; the server refuses any other
// key). The self-report: the Source the executor actually runs (status versions.windows.ciSourceManifestSha256, never the
// companion's own configuration), the node mode and the newest probe result, the state (NORMAL, HALTED with its code and time
// from status.halt and the batch's PR and head from status.current, PAUSED, INTAKE_PAUSED with its end, or UNKNOWN when the
// service is stopped, the snapshot cannot be read or is older than SNAPSHOT_FRESH_MS), whether the service runs (SCM) and the
// snapshot's age.
//
// The answer { status:'ok', received_at, node_ids, node_binding_id, via_link, intake_paused_until, watchdog:{ last_tick_at, stale },
// auto_handovers:[{ receipt_id, from_binding_id, to_binding_id, effective_at, trigger, created_at }] } (parseHeartbeatReply, tolerant:
// a missing or unknown optional part never makes a beat count as failed; node_binding_id is the node's CI connection the beat was
// recorded on, via_link whether it came through the linked heartbeat connection) or { status:'rejected', error_code:
// 'ci_node_not_registered' } (its own notice: the heartbeat connection is not linked to a node, which the Owner does on KooYomi's
// /bindings/failover) or 'heartbeat_connection_only' (the server took the token for a heartbeat connection and refused the action:
// should not happen for ci_node_heartbeat; a misconfiguration notice, never "token refused"). The server lists only automatic take-overs TO this node's connection (the last 24 hours), by connection id, never by
// node name (so there is no name to compare: R3 MINOR 9 is moot on the real wire): the companion comments once per receipt on the
// compute panel's issue with the Owner's gh login, @-mentioning the Owner, marked <!-- clued-auto-handover:<receipt id> --> (the
// panel recognises the marker and does not mention the Owner again). The watchdog: stale (the server's own five minutes, or
// older than WATCHDOG_STALE_MS) raises a notification and, while it stays so, "自动接班看门狗未运行" on the PR page status
// (watchdogStale, read by pr-status.mjs#PrStatusReporter). Three failures in a row, or a token the server refused, raise one
// notification per spell asking the Owner to replace the token (the server still judges silence as silence: the Owner has 30
// minutes, or turns the master switch off).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NODE_NAME } from './node-duty.mjs';

// The CI command door (clued_work_verify_v1 -> work_claim_ci_command_v1) and its heartbeat action.
export const HEARTBEAT_RPC = 'clued_work_verify_v1';
export const HEARTBEAT_ACTION = 'ci_node_heartbeat';
export const HEARTBEAT_INPUT_KEYS = Object.freeze(['action', 'scope', 'state', 'mode', 'probe', 'intake_paused_until', 'halt', 'ci_source_manifest_sha256',
  'service_running', 'snapshot_age_seconds', 'node_name']);
export const NODE_HEARTBEAT_EVERY_MS = 10 * 60_000;
export const HEARTBEAT_FAILURES_NOTIFY = 3;
export const WATCHDOG_STALE_MS = 5 * 60_000;
// The executor's own staleness rule (status.mjs STATUS_STALE_MS): an older snapshot reports UNKNOWN.
export const SNAPSHOT_FRESH_MS = 5 * 60_000;
export const HEARTBEAT_TOKEN_DIR = path.join('secrets', 'heartbeat');
export const HEARTBEAT_TOKEN_FILE = 'ci-node-heartbeat.token';
export const HEARTBEAT_TIMEOUT_MS = 20_000;
export const HANDOVER_MARKER = id => `<!-- clued-auto-handover:${id} -->`;
// The compute panel's own issue marker and author (scripts/ci/self-hosted/compute_panel.py MARKER, find_issue).
export const PANEL_MARKER = '<!-- clued-compute-panel:v1 -->';
export const PANEL_AUTHOR = 'github-actions[bot]';
export const STATES = Object.freeze(['NORMAL', 'HALTED', 'PAUSED', 'INTAKE_PAUSED', 'UNKNOWN']);
export const NOT_REGISTERED = 'ci_node_not_registered';
const REPLY_MAX_BYTES = 64 * 1024;
const HALT_MAX_BYTES = 2048;
const TOKEN = /^[A-Za-z0-9_.-]{20,512}$/;
const HEX64 = /^[0-9a-f]{64}$/, HEX40 = /^[0-9a-f]{40}$/, CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PROBE = /^[a-z][a-z-]{0,39}$/;
const SCOPE = /^(?:global|project:[a-f0-9-]{36})$/;
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const isoOf = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The server's p_input from what the companion sees (exactly the keys ci_node_heartbeat_v1 accepts). status: status.mjs#parseStatus
// or null; serviceRunning: true | false | null (SCM unreadable: the snapshot's freshness stands in, the server needs a boolean).
export function heartbeatPayload({ nodeName, scope, status, statusError = false, serviceRunning = null, now }) {
  const age = status && Number.isFinite(status.writtenAt) ? Math.max(0, now - status.writtenAt) : null;
  const fresh = !!status && !statusError && age !== null && age <= SNAPSHOT_FRESH_MS;
  const running = [true, false].includes(serviceRunning) ? serviceRunning : fresh;
  const readable = fresh && running;
  let state = 'UNKNOWN', halt = null, intakeUntil = null;
  if (readable) {
    if (status.halt) {
      state = 'HALTED';
      halt = { code: CODE.test(status.halt.code ?? '') ? status.halt.code : 'HALTED', at: iso(status.halt.at),
        pr: Number.isSafeInteger(status.current?.pr) ? status.current.pr : null, headSha: HEX40.test(status.current?.headSha ?? '') ? status.current.headSha : null };
    } else if (status.paused) state = 'PAUSED';
    else if (status.intakePause) {
      intakeUntil = iso(status.intakePause.until);
      // An intake pause without a readable end cannot be reported as one (the server needs its end): UNKNOWN, so the server
      // judges by the last readable report.
      state = intakeUntil ? 'INTAKE_PAUSED' : 'UNKNOWN';
    } else state = 'NORMAL';
  }
  const source = status?.versions?.windows?.ciSourceManifestSha256;
  const knownMode = ['ACTIVE', 'STANDBY', 'UNCERTAIN'].includes(status?.node?.mode) ? status.node.mode : null;
  // A readable state needs a mode (the server refuses one without): a snapshot without a node says UNCERTAIN (never a target).
  const mode = state === 'UNKNOWN' ? (readable ? knownMode : null) : (knownMode ?? 'UNCERTAIN');
  const probe = readable && PROBE.test(status?.node?.probe?.result ?? '') ? status.node.probe.result : null;
  const p = { action: HEARTBEAT_ACTION, scope: SCOPE.test(scope ?? '') ? scope : 'global', state, mode, probe,
    ...(state === 'INTAKE_PAUSED' ? { intake_paused_until: intakeUntil } : {}),
    halt: state === 'HALTED' && Buffer.byteLength(JSON.stringify(halt)) <= HALT_MAX_BYTES ? halt : null,
    ci_source_manifest_sha256: HEX64.test(source ?? '') ? source : null, service_running: running,
    snapshot_age_seconds: age === null ? null : Math.min(999_999_999, Math.floor(age / 1000)) };
  if (NODE_NAME.test(nodeName ?? '')) p.node_name = nodeName;
  return Object.freeze(p);
}

// What a change means: anything but the snapshot's age (which moves every pass).
const fingerprint = p => JSON.stringify({ ...p, snapshot_age_seconds: null });

const FAILED = Object.freeze({ ok: false, tokenRefused: false, notRegistered: false, serverNotReady: false, connectionOnly: false, autoHandovers: Object.freeze([]), watchdogTickAt: null, watchdogStale: null });
// A server without the heartbeat action (before merge-train step 2b): the CI command door checks the ci-admission role
// before any action and answers admission_binding_required, which says nothing about the token (Task 293a092a): its own
// notice, never "token refused". A 400 work_claim_ci_command_invalid is NOT that: from step 2b on it is the heartbeat
// refusing this payload, a real failed beat (review W2 MAJOR 1).
const NOT_READY = Object.freeze({ ...FAILED, serverNotReady: true });

// The server's answer, tolerantly: { ok, tokenRefused, notRegistered, serverNotReady, connectionOnly, autoHandovers: [{ receiptId, from,
// to, at, trigger }], watchdogTickAt (ms | null), watchdogStale (boolean | null: unknown), and on ok nodeBindingId (uuid | null) and
// viaLink (boolean | null): optional, never required }. Never throws. ok is status 'ok' alone: a missing or odd
// watchdog or handover list only leaves that part unknown or empty; a handover entry that does not fit is skipped.
export function parseHeartbeatReply(v) {
  if (!plain(v)) return FAILED;
  if (v.status === 'rejected' && v.error_code === 'admission_binding_required') return NOT_READY;
  if (v.status === 'rejected' && v.error_code === 'heartbeat_connection_only') return { ...FAILED, connectionOnly: true };
  if (v.status === 'rejected') return { ...FAILED, notRegistered: v.error_code === NOT_REGISTERED, tokenRefused: v.error_code === 'binding_not_authorized' };
  if (v.status !== 'ok') return FAILED;
  const w = plain(v.watchdog) ? v.watchdog : null;
  const tick = Date.parse(w?.last_tick_at ?? '');
  const watchdogTickAt = Number.isFinite(tick) ? tick : null;
  const watchdogStale = typeof w?.stale === 'boolean' ? w.stale : null;
  const autoHandovers = [];
  for (const h of Array.isArray(v.auto_handovers) ? v.auto_handovers.slice(0, 50) : []) {
    if (!plain(h) || !UUID.test(h.receipt_id ?? '')) continue;
    const at = isoOf(h.effective_at) ?? isoOf(h.created_at);
    autoHandovers.push(Object.freeze({ receiptId: h.receipt_id.toLowerCase(), from: UUID.test(h.from_binding_id ?? '') ? h.from_binding_id.toLowerCase() : null,
      to: UUID.test(h.to_binding_id ?? '') ? h.to_binding_id.toLowerCase() : null, at, trigger: typeof h.trigger === 'string' && h.trigger.length <= 64 ? h.trigger : null }));
  }
  return { ok: true, tokenRefused: false, notRegistered: false, serverNotReady: false, connectionOnly: false, autoHandovers: Object.freeze(autoHandovers), watchdogTickAt, watchdogStale,
    nodeBindingId: UUID.test(v.node_binding_id ?? '') ? v.node_binding_id.toLowerCase() : null, viaLink: typeof v.via_link === 'boolean' ? v.via_link : null };
}

// The one wire call (the transport interface: send({ payload }, { token }) -> parseHeartbeatReply's shape). Same call shape as every
// other node RPC (scripts/ci/clued-work-admission.mjs#cluedRpc): POST <supabaseUrl>/rest/v1/rpc/clued_work_verify_v1, apikey and
// Bearer the publishable key, body { p_token_hash: sha256 hex of the token, p_input: payload }. 401/403 (binding_not_authorized,
// authorization_revoked_or_expired): the token is refused. Anything else that is not a 200 (400 work_claim_ci_command_invalid, 404
// before the migration, a timeout) is a failed beat. The token itself never leaves the process; no body is ever logged.
export function supabaseHeartbeatTransport({ supabaseUrl, publishableKey, fetchImpl = globalThis.fetch, timeoutMs = HEARTBEAT_TIMEOUT_MS }) {
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(supabaseUrl ?? '') || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey ?? '')) throw new Error('HEARTBEAT_TRANSPORT_CONFIG_INVALID');
  return async ({ payload }, { token }) => {
    try {
      const r = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${HEARTBEAT_RPC}`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_token_hash: createHash('sha256').update(token, 'utf8').digest('hex'), p_input: payload }) });
      const text = await r.text();
      if (Buffer.byteLength(text) > REPLY_MAX_BYTES) return FAILED;
      if (r.status === 401 || r.status === 403) return { ...FAILED, tokenRefused: true };
      if (r.status !== 200) return FAILED;
      return parseHeartbeatReply(JSON.parse(text));
    } catch { return FAILED; }
  };
}

// The installed token (resident\secrets\heartbeat\ci-node-heartbeat.token), or null when none is installed or it does not fit.
export async function readHeartbeatToken(root, fsImpl = fs) {
  let bytes;
  try { bytes = await fsImpl.readFile(path.join(root, HEARTBEAT_TOKEN_DIR, HEARTBEAT_TOKEN_FILE)); } catch { return null; }
  if (bytes.length > 1024) return null;
  const t = bytes.toString('utf8').trim();
  return TOKEN.test(t) ? t : null;
}

// SCM: whether CluedCIResident runs (sc.exe query; null when the answer cannot be read).
export const scQueryArgv = scExe => [scExe, 'query', 'CluedCIResident'];
export function serviceRunningFrom(r) {
  const out = String(r?.stdout ?? '');
  if (/STATE\s*:\s*4\s+RUNNING/.test(out)) return true;
  return /STATE\s*:\s*\d+\s+[A-Z_]+/.test(out) ? false : null;
}

// The compute panel's issue comment for one automatic take-over to this node (only fixed words, this node's name and the
// receipt's own values: connection ids, not names, are what the server lists).
export function handoverComment(h, ownerLogin, nodeName) {
  const from = h.from ? `连接 ${h.from}` : '原持有节点';
  return `${HANDOVER_MARKER(h.receiptId)}\n@${ownerLogin} 自动接班：ci-admission 已从${from}交给本节点 ${nodeName}（${h.at ?? '时刻未知'}，回执 ${h.receiptId}）。服务端看门狗判定原持有节点失联；不会自动交回，需要时请在 /bindings 用一键移交。`;
}

export class CompanionHeartbeat {
  // ports: { nodeName, scope (the installed record's), transport (supabaseHeartbeatTransport or a test double), readToken() -> token
  //   | null, readStatus() -> status (throws when unreadable), serviceRunning() -> true | false | null, clock, notify(key, title, body)
  //   (one Windows toast per key), memory: { get(key), set(key, value) } (the companion's own store), handover: { ownerLogin(),
  //   panelIssue() -> number | null, commentExists(issue, marker) -> bool | null, comment(issue, body) -> bool } (the Owner's gh) }
  constructor(ports) {
    Object.assign(this, ports);
    this.lastSentAt = null; this.lastFingerprint = null; this.failures = 0; this.failingSince = null; this.watchdogStale = false; this.unregisteredSince = null;
    this.connectionOnlySince = null; this.notReadySince = null; this.nodeBindingId = null; this.viaLink = null;
  }

  async step() {
    let token = null;
    try { token = await this.readToken(); } catch { token = null; }
    if (!token) return { skipped: 'NO_TOKEN' };
    const now = this.clock();
    let status = null, statusError = false, running = null;
    try { status = await this.readStatus(); } catch { statusError = true; }
    try { running = await this.serviceRunning(); } catch { running = null; }
    const payload = heartbeatPayload({ nodeName: this.nodeName, scope: this.scope, status, statusError, serviceRunning: running, now });
    const changed = this.lastFingerprint !== null && fingerprint(payload) !== this.lastFingerprint;
    if (this.lastSentAt !== null && now - this.lastSentAt < NODE_HEARTBEAT_EVERY_MS && !changed) return { skipped: 'NOT_DUE' };
    let r;
    try { r = await this.transport({ payload }, { token }); } catch { r = null; }
    this.lastSentAt = now;
    if (r?.notRegistered === true) {
      // The server knows no node for this token's connection: its own notice (the beat is no heartbeat at all for the watchdog).
      // These three answers neither count nor clear real failures (review W2 MINOR 3).
      this.unregisteredSince ??= now;
      await this.say(`heartbeat-unregistered:${this.unregisteredSince}`, '节点心跳未登记', '服务端没有本节点的登记（ci_node_not_registered）：心跳不被记下，自动接班看不到本节点。请 Owner 在 KooYomi 的 /bindings/failover 把心跳连接挂到本节点（两步确认），并核对本节点的 CI 连接。');
      return { sent: false, payload, notRegistered: true };
    }
    this.unregisteredSince = null;
    if (r?.serverNotReady === true) {
      // Not a failure of this node or its token: the server has no heartbeat yet. One notice per spell; no failure count.
      this.notReadySince ??= now;
      await this.say(`heartbeat-server-not-ready:${this.notReadySince}`, '服务端还不收心跳', '服务端还没有节点心跳功能（合并列车第 2 步 b 未上线）：心跳暂不被记下，自动接班看不到本节点。令牌没有问题，不用换令牌或重装；服务端上线后自动恢复。');
      return { sent: false, payload, serverNotReady: true };
    }
    this.notReadySince = null;
    if (r?.connectionOnly === true) {
      // heartbeat_connection_only: the server refused the heartbeat action itself to this heartbeat connection. Should not happen; a
      // misconfiguration of the server or of the link, not of this token: its own notice, no failure count, never "token refused".
      this.connectionOnlySince ??= now;
      await this.say(`heartbeat-connection-only:${this.connectionOnlySince}`, '心跳连接配置有误', '服务端对本节点的心跳答 heartbeat_connection_only（心跳连接只能发心跳，却连心跳也被拒）：本不应发生，心跳不被记下。令牌本身没有被拒，不用换令牌；请 Owner 在 KooYomi 的 /bindings/failover 核对心跳连接与本节点的挂接，仍不行就告诉维护者。');
      return { sent: false, payload, connectionOnly: true };
    }
    this.connectionOnlySince = null;
    if (!r?.ok) {
      this.failures += 1;
      this.failingSince ??= now;
      if (this.failures >= HEARTBEAT_FAILURES_NOTIFY || r?.tokenRefused === true) {
        await this.say(`heartbeat-failing:${this.failingSince}`, '节点心跳发不出去', r?.tokenRefused === true
          ? '服务端拒绝了本节点的心跳令牌（过期或被撤销）。请在 /bindings 换一个心跳令牌，用 -HeartbeatTokenFile 重新安装；30 分钟内不处理，服务端会按失联判断。'
          : `已连续 ${this.failures} 次发不出心跳。请检查网络和心跳令牌；30 分钟内不处理，服务端会按失联判断（可先关掉自动接班总开关）。`);
      }
      return { sent: false, payload, failures: this.failures };
    }
    this.failures = 0; this.failingSince = null; this.lastFingerprint = fingerprint(payload);
    // Informational (node_binding_id, via_link): which node's CI connection the server recorded the beat on, and whether it came
    // through the linked heartbeat connection. Never required; an answer without them leaves them null.
    this.nodeBindingId = r.nodeBindingId ?? null; this.viaLink = r.viaLink ?? null;
    // Kept for the PR page status (pr-status.mjs#withWatchdogLine) until an answer says otherwise; a failed beat or an answer
    // without a readable watchdog keeps it.
    const stale = r.watchdogStale ?? (r.watchdogTickAt !== null ? now - r.watchdogTickAt > WATCHDOG_STALE_MS : null);
    if (stale !== null) this.watchdogStale = stale;
    if (stale === true) {
      await this.say(`watchdog-stale:${r.watchdogTickAt ?? 'never'}`, '自动接班看门狗未运行', `服务端看门狗${r.watchdogTickAt !== null ? `自 ${iso(r.watchdogTickAt)} 起` : ''}没有运行（超过 5 分钟）：失联的节点不会被自动交出。请检查 KooYomi 的 pg_cron 作业 clued-ci-admission-failover。`);
    }
    // The server lists only take-overs to this node's connection.
    for (const h of r.autoHandovers ?? []) await this.relayHandover(h);
    return { sent: true, payload, watchdogStale: this.watchdogStale, autoHandovers: r.autoHandovers ?? [], nodeBindingId: this.nodeBindingId, viaLink: this.viaLink };
  }

  async say(key, title, body) {
    try { if (await this.memory.get(key)) return; await this.memory.set(key, this.clock()); await this.notify(key, title, body); } catch { /* advisory */ }
  }

  // Once per receipt: remembered locally, and the panel's issue is read for the marker first (another start, another machine).
  async relayHandover(h) {
    const key = `auto-handover:${h.receiptId}`;
    try {
      if (await this.memory.get(key)) return false;
      const login = await this.handover.ownerLogin();
      const issue = await this.handover.panelIssue();
      if (!login || !Number.isSafeInteger(issue)) return false;
      const seen = await this.handover.commentExists(issue, HANDOVER_MARKER(h.receiptId));
      if (seen === null) return false;
      if (!seen && !(await this.handover.comment(issue, handoverComment(h, login, this.nodeName)))) return false;
      await this.memory.set(key, this.clock());
      return true;
    } catch { return false; }
  }
}

// The Owner's gh for the take-over comment (companion-main.mjs builds it over the advisory lane's runner).
export function ghHandoverPort({ ghExe, repo, run, timeoutMs = 15_000 }) {
  const api = (args, jq) => run([ghExe, 'api', ...args, ...(jq ? ['--jq', jq] : [])], { timeoutMs });
  return {
    async ownerLogin() { const r = await api(['--method', 'GET', 'user'], '.login'); const l = r.code === 0 ? String(r.stdout).trim() : ''; return /^[A-Za-z0-9-]{1,39}$/.test(l) ? l : null; },
    async panelIssue() {
      const r = await api(['--method', 'GET', `repos/${repo}/issues?state=open&creator=${encodeURIComponent(PANEL_AUTHOR)}&per_page=100`],
        `[.[] | select(.pull_request == null) | select((.body // "") | contains("${PANEL_MARKER}")) | .number][0]`);
      const n = r.code === 0 ? Number(String(r.stdout).trim()) : NaN;
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    },
    async commentExists(issue, marker) {
      const r = await api(['--method', 'GET', '--paginate', `repos/${repo}/issues/${issue}/comments?per_page=100`], `[.[] | select((.body // "") | contains("${marker}"))] | length`);
      if (r.code !== 0) return null;
      return String(r.stdout).split(/\s+/).filter(Boolean).some(x => Number(x) > 0);
    },
    async comment(issue, body) { return (await api(['--method', 'POST', `repos/${repo}/issues/${issue}/comments`, '-f', `body=${body}`])).code === 0; },
  };
}
