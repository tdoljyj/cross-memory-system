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
// ci_source_manifest_sha256, service_running, snapshot_age_seconds, node_name, [fleet_delivery] } (heartbeatPayload; the server refuses any other
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
// notification per spell asking the Owner to replace the token (the server still judges silence as silence: after
// FAILOVER_SILENCE_MINUTES it hands the role over, unless the Owner turned the master switch off).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NODE_NAME } from './node-duty.mjs';
import { fleetEvidencePayload, freshDeliveryTime } from './fleet-delivery-evidence.mjs';
import { parseIncluded } from './poller.mjs';

// The CI command door (clued_work_verify_v1 -> work_claim_ci_command_v1) and its heartbeat action.
export const HEARTBEAT_RPC = 'clued_work_verify_v1';
export const HEARTBEAT_ACTION = 'ci_node_heartbeat';
export const HEARTBEAT_INPUT_KEYS = Object.freeze(['action', 'scope', 'state', 'mode', 'probe', 'intake_paused_until', 'halt', 'ci_source_manifest_sha256',
  'service_running', 'snapshot_age_seconds', 'node_name', 'fleet_delivery']);
// Every minute (ADR 0026; was 10 minutes): the failover watchdog judges a holder lost after FAILOVER_SILENCE_MINUTES without a beat,
// so a node that is alive must be heard well inside that. A failed beat is tried again at the next lane pass (30 s), not after a
// whole interval, so one lost request never looks like silence.
export const NODE_HEARTBEAT_EVERY_MS = 60_000;
// The watchdog's own rule (migration 20261112130500_ci_failover_fast_v1.sql, ci_failover_rules_v1 silence_minutes); only for the texts.
export const FAILOVER_SILENCE_MINUTES = 5;
export const HEARTBEAT_FAILURES_NOTIFY = 3;
export const WATCHDOG_STALE_MS = 5 * 60_000;
// The executor's own staleness rule (status.mjs STATUS_STALE_MS): an older snapshot reports UNKNOWN.
export const SNAPSHOT_FRESH_MS = 5 * 60_000;
export const HEARTBEAT_TOKEN_DIR = path.join('secrets', 'heartbeat');
export const HEARTBEAT_TOKEN_FILE = 'ci-node-heartbeat.token';
export const HEARTBEAT_TIMEOUT_MS = 20_000;
export const HANDOVER_MARKER = id => `<!-- clued-auto-handover:${id} -->`;
const HANDOVER_MAX_ATTEMPTS = 3;
const HANDOVER_RETRY_MS = 30_000;
const HANDOVER_RETRY_WINDOW_MS = 5 * 60_000;
const HANDOVER_RECOVERY_MS = 10 * 60_000;
const HANDOVER_DEDUP_MS = 24 * 60 * 60_000; // The server replays the last 24 hours of receipts.
const HANDOVER_STATES = new Set(['pending', 'undelivered', 'unknown', 'delivered']);
const COMMENT_REJECTED = new Set([400, 401, 403, 404, 410, 422, 429]);
const COMMENT_NOT_STARTED = new Set(['RUNNER_ARGV_REFUSED', 'RUNNER_BUSY_WITH_UNFINISHED_CHILD', 'RUNNER_TIMEOUT_REFUSED', 'RUNNER_SPAWN_FAILED']);
// The compute panel's own issue marker and author (scripts/ci/self-hosted/compute_panel.py MARKER, find_issue).
export const PANEL_MARKER = '<!-- clued-compute-panel:v1 -->';
export const PANEL_AUTHOR = 'github-actions[bot]';
export const STATES = Object.freeze(['NORMAL', 'HALTED', 'PAUSED', 'INTAKE_PAUSED', 'UNKNOWN']);
export const NOT_REGISTERED = 'ci_node_not_registered';
const REPLY_MAX_BYTES = 64 * 1024;
const HALT_MAX_BYTES = 2048;
// The heartbeat connection's token: clued_hbt_ and 43 base64url characters (32 random bytes, as the server issues it).
const TOKEN = /^clued_hbt_[A-Za-z0-9_-]{43}$/;
const HEX64 = /^[0-9a-f]{64}$/, HEX40 = /^[0-9a-f]{40}$/, CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PROBE = /^[a-z][a-z-]{0,39}$/;
const SCOPE = /^(?:global|project:[a-f0-9-]{36})$/;
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const isoOf = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The server's p_input from what the companion sees (exactly the keys ci_node_heartbeat_v1 accepts). status: status.mjs#parseStatus
// or null; serviceRunning: true | false | null (SCM unreadable: the snapshot's freshness stands in, the server needs a boolean).
export function heartbeatPayload({ nodeName, scope, status, statusError = false, serviceRunning = null, now, delivery = null }) {
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
  const evidence = readable ? fleetEvidencePayload(delivery) : null;
  if (evidence && evidence.windowsSourceSha256 === p.ci_source_manifest_sha256 &&
      freshDeliveryTime(evidence.brokerObservedAt, now) && freshDeliveryTime(evidence.linuxObservedAt, now)) p.fleet_delivery = evidence;
  return Object.freeze(p);
}

// What a change means: anything but the snapshot's age (which moves every pass).
const fingerprint = p => JSON.stringify({ ...p, snapshot_age_seconds: null, fleet_delivery: null });

const FAILED = Object.freeze({ ok: false, tokenRefused: false, notRegistered: false, serverNotReady: false, connectionOnly: false, autoHandovers: Object.freeze([]), watchdogTickAt: null, watchdogStale: null });
const WIRE_ERRORS = new Set(['TRANSPORT_ERROR', 'TRANSPORT_TIMEOUT', 'TRANSPORT_CONFIG', 'HTTP_ERROR', 'INVALID_REPLY', 'SERVER_REJECTED']);
function heartbeatError(reply) {
  if (reply?.ok) return null;
  if (reply?.notRegistered) return 'NOT_REGISTERED';
  if (reply?.serverNotReady) return 'SERVER_NOT_READY';
  if (reply?.connectionOnly) return 'CONNECTION_ONLY';
  if (reply?.tokenRefused) return 'TOKEN_REFUSED';
  return WIRE_ERRORS.has(reply?.errorKind) ? reply.errorKind : 'TRANSPORT_ERROR';
}
// A server without the heartbeat action (before merge-train step 2b): the CI command door checks the ci-admission role
// before any action and answers admission_binding_required, which says nothing about the token (Task 293a092a): its own
// notice, never "token refused". A 400 work_claim_ci_command_invalid is NOT that: from step 2b on it is the heartbeat
// refusing this payload, a real failed beat (review W2 MAJOR 1).
const NOT_READY = Object.freeze({ ...FAILED, serverNotReady: true });

// The server's answer, tolerantly: { ok, tokenRefused, notRegistered, serverNotReady, connectionOnly, autoHandovers: [{ receiptId, from,
// to, at (effective), trigger, createdAt (when the watchdog ended the old holder's role; null when not given) }], watchdogTickAt (ms | null), watchdogStale (boolean | null: unknown), and on ok nodeBindingId (uuid | null) and
// viaLink (boolean | null): optional, never required }. Never throws. ok is status 'ok' alone: a missing or odd
// watchdog or handover list only leaves that part unknown or empty; a handover entry that does not fit is skipped.
export function parseHeartbeatReply(v) {
  if (!plain(v)) return { ...FAILED, errorKind: 'INVALID_REPLY' };
  if (v.status === 'rejected' && v.error_code === 'admission_binding_required') return NOT_READY;
  if (v.status === 'rejected' && v.error_code === 'heartbeat_connection_only') return { ...FAILED, connectionOnly: true };
  if (v.status === 'rejected') return { ...FAILED, notRegistered: v.error_code === NOT_REGISTERED, tokenRefused: v.error_code === 'binding_not_authorized', errorKind: 'SERVER_REJECTED' };
  if (v.status !== 'ok') return { ...FAILED, errorKind: 'INVALID_REPLY' };
  const w = plain(v.watchdog) ? v.watchdog : null;
  const tick = Date.parse(w?.last_tick_at ?? '');
  const watchdogTickAt = Number.isFinite(tick) ? tick : null;
  const watchdogStale = typeof w?.stale === 'boolean' ? w.stale : null;
  const autoHandovers = [];
  for (const h of Array.isArray(v.auto_handovers) ? v.auto_handovers.slice(0, 50) : []) {
    if (!plain(h) || !UUID.test(h.receipt_id ?? '')) continue;
    const at = isoOf(h.effective_at) ?? isoOf(h.created_at);
    autoHandovers.push(Object.freeze({ receiptId: h.receipt_id.toLowerCase(), from: UUID.test(h.from_binding_id ?? '') ? h.from_binding_id.toLowerCase() : null,
      to: UUID.test(h.to_binding_id ?? '') ? h.to_binding_id.toLowerCase() : null, at, trigger: typeof h.trigger === 'string' && h.trigger.length <= 64 ? h.trigger : null,
      createdAt: isoOf(h.created_at) }));
  }
  return { ok: true, receivedAt: isoOf(v.received_at), tokenRefused: false, notRegistered: false, serverNotReady: false, connectionOnly: false, autoHandovers: Object.freeze(autoHandovers), watchdogTickAt, watchdogStale,
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
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const r = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${HEARTBEAT_RPC}`, { method: 'POST', signal,
        headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_token_hash: createHash('sha256').update(token, 'utf8').digest('hex'), p_input: payload }) });
      const text = await r.text();
      if (r.status === 401 || r.status === 403) return { ...FAILED, tokenRefused: true };
      if (r.status !== 200) return { ...FAILED, errorKind: r.status >= 400 && r.status < 500 ? 'SERVER_REJECTED' : 'HTTP_ERROR' };
      if (Buffer.byteLength(text) > REPLY_MAX_BYTES) return { ...FAILED, errorKind: 'INVALID_REPLY' };
      try { return parseHeartbeatReply(JSON.parse(text)); } catch { return { ...FAILED, errorKind: 'INVALID_REPLY' }; }
    } catch { return { ...FAILED, errorKind: signal.aborted ? 'TRANSPORT_TIMEOUT' : 'TRANSPORT_ERROR' }; }
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

const validIssue = issue => Number.isSafeInteger(issue) && issue > 0;

export class CompanionHeartbeat {
  // ports: { nodeName, scope (the installed record's), transport (supabaseHeartbeatTransport or a test double), readToken() -> token
  //   | null, readStatus() -> status (throws when unreadable), serviceRunning() -> true | false | null, clock, notify(key, title, body)
  //   (one Windows toast per key), memory: { get(key), set(key, value) } (the companion's own store), handover: { ownerLogin(),
  //   panelIssue() -> number | null, commentExists(issue, marker) -> bool | null, comment(issue, body) -> true (created), false
  //   (rejected), or null (unknown) } (the Owner's gh), handoverOutbox: { load(), save(records) } (production),
  //   handoverClock (monotonic in production), recordDiagnostics(snapshot) (optional, schedules a local save) }
  constructor(ports) {
    Object.assign(this, ports);
    this.handoverClock ??= this.clock;
    this.lastSentAt = null; this.lastFingerprint = null; this.failures = 0; this.failingSince = null; this.watchdogStale = false; this.unregisteredSince = null;
    this.connectionOnlySince = null; this.notReadySince = null; this.nodeBindingId = null; this.viaLink = null;
    this.diagnostics = { pid: process.pid, lastAttemptAt: null, lastServerAckAt: null, lastErrorKind: null };
    this.handovers = new Map();
    this.handoverBusy = false; this.handoverDirty = false; this.handoverLoaded = !this.handoverOutbox;
    this.alertsInFlight = new Set();
    // ADR 0026: when the watchdog last handed ci-admission to this node (ms, server time), or null. The take-over check
    // (node-duty.mjs) does not hold back for duty statements written before it: the server had found their writer silent.
    this.autoHandoverSince = null;
  }

  async step() {
    let token = null;
    try { token = await this.readToken(); } catch { token = null; }
    if (!token) return { skipped: 'NO_TOKEN' };
    const now = this.clock();
    let status = null, statusError = false, running = null;
    try { status = await this.readStatus(); } catch { statusError = true; }
    try { running = await this.serviceRunning(); } catch { running = null; }
    const input = { nodeName: this.nodeName, scope: this.scope, status, statusError, serviceRunning: running, now };
    let payload = heartbeatPayload(input);
    const changed = this.lastFingerprint !== null && fingerprint(payload) !== this.lastFingerprint;
    // A clock that went back (now < lastSentAt) is due at once: waiting for it to catch up would be silence to the server, whose own
    // clock stamps every beat (ADR 0026; with a 5-minute silence rule a 10-minute jump back would hand the role away).
    if (this.lastSentAt !== null && this.failures === 0 && now >= this.lastSentAt && now - this.lastSentAt < NODE_HEARTBEAT_EVERY_MS && !changed) return { skipped: 'NOT_DUE' };
    if (this.readDeliveryEvidence && payload.state !== 'UNKNOWN') {
      const delivery = await this.readDeliveryEvidence({ status, now }).catch(() => null);
      payload = heartbeatPayload({ ...input, delivery });
    }
    this.updateDiagnostics({ lastAttemptAt: iso(this.clock()) });
    let r;
    try { r = await this.transport({ payload }, { token }); } catch { r = null; }
    this.updateDiagnostics({ lastErrorKind: heartbeatError(r), lastServerAckAt: (r?.ok ? isoOf(r.receivedAt) : null) ?? this.diagnostics.lastServerAckAt });
    this.lastSentAt = now;
    if (r?.notRegistered === true) {
      // The server knows no node for this token's connection: its own notice (the beat is no heartbeat at all for the watchdog).
      // These three answers neither count nor clear real failures (review W2 MINOR 3).
      this.unregisteredSince ??= now;
      void this.say(`heartbeat-unregistered:${this.unregisteredSince}`, '节点心跳未登记', '服务端没有本节点的登记（ci_node_not_registered）：心跳不被记下，自动接班看不到本节点。请 Owner 在 KooYomi 的 /bindings/failover 把心跳连接挂到本节点（两步确认），并核对本节点的 CI 连接。');
      return { sent: false, payload, notRegistered: true };
    }
    this.unregisteredSince = null;
    if (r?.serverNotReady === true) {
      // Not a failure of this node or its token: the server has no heartbeat yet. One notice per spell; no failure count.
      this.notReadySince ??= now;
      void this.say(`heartbeat-server-not-ready:${this.notReadySince}`, '服务端还不收心跳', '服务端还没有节点心跳功能（合并列车第 2 步 b 未上线）：心跳暂不被记下，自动接班看不到本节点。令牌没有问题，不用换令牌或重装；服务端上线后自动恢复。');
      return { sent: false, payload, serverNotReady: true };
    }
    this.notReadySince = null;
    if (r?.connectionOnly === true) {
      // heartbeat_connection_only: the server refused the heartbeat action itself to this heartbeat connection. Should not happen; a
      // misconfiguration of the server or of the link, not of this token: its own notice, no failure count, never "token refused".
      this.connectionOnlySince ??= now;
      void this.say(`heartbeat-connection-only:${this.connectionOnlySince}`, '心跳连接配置有误', '服务端对本节点的心跳答 heartbeat_connection_only（心跳连接只能发心跳，却连心跳也被拒）：本不应发生，心跳不被记下。令牌本身没有被拒，不用换令牌；请 Owner 在 KooYomi 的 /bindings/failover 核对心跳连接与本节点的挂接，仍不行就告诉维护者。');
      return { sent: false, payload, connectionOnly: true };
    }
    this.connectionOnlySince = null;
    if (!r?.ok) {
      this.failures += 1;
      this.failingSince ??= now;
      if (this.failures >= HEARTBEAT_FAILURES_NOTIFY || r?.tokenRefused === true) {
        void this.say(`heartbeat-failing:${this.failingSince}`, '节点心跳发不出去', r?.tokenRefused === true
          ? `服务端拒绝了本节点的心跳令牌（过期或被撤销）。请在 /bindings 换一个心跳令牌，用 -HeartbeatTokenFile 重新安装；${FAILOVER_SILENCE_MINUTES} 分钟发不出心跳，服务端就按失联判断（可先关掉自动接班总开关）。`
          : `已连续 ${this.failures} 次发不出心跳。请检查网络和心跳令牌；${FAILOVER_SILENCE_MINUTES} 分钟发不出心跳，服务端就按失联判断（可先关掉自动接班总开关）。`);
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
      void this.say(`watchdog-stale:${r.watchdogTickAt ?? 'never'}`, '自动接班看门狗未运行', `服务端看门狗${r.watchdogTickAt !== null ? `自 ${iso(r.watchdogTickAt)} 起` : ''}没有运行（超过 5 分钟）：失联的节点不会被自动交出。请检查 KooYomi 的 pg_cron 作业 clued-ci-admission-failover。`);
    }
    // The server lists only take-overs to this node's connection.
    for (const h of r.autoHandovers ?? []) {
      const created = Date.parse(h.createdAt ?? '');
      if (Number.isFinite(created) && !(this.autoHandoverSince >= created)) this.autoHandoverSince = created;
      if (this.handovers.has(h.receiptId)) continue;
      const receipt = { receiptId: h.receiptId, from: h.from ?? null, at: h.at ?? null };
      const receivedAt = this.clock();
      this.rememberHandover({ receipt, status: 'pending', issue: null, attempts: 0, firstSeenAt: receivedAt, retryAt: receivedAt });
      this.handoverDirty = true;
    }
    return { sent: true, payload, watchdogStale: this.watchdogStale, autoHandovers: r.autoHandovers ?? [], nodeBindingId: this.nodeBindingId, viaLink: this.viaLink };
  }

  updateDiagnostics(fields) {
    this.diagnostics = { ...this.diagnostics, ...fields };
    try { this.recordDiagnostics?.(this.diagnostics); } catch { /* diagnostics are best effort */ }
  }

  rememberHandover(record) {
    const now = this.clock(), monotonic = this.handoverClock();
    this.handovers.set(record.receipt.receiptId, { record,
      nextAt: monotonic + Math.max(0, record.retryAt - now),
      deadline: monotonic + HANDOVER_RETRY_WINDOW_MS - Math.max(0, now - record.firstSeenAt) });
  }

  updateHandover(item, fields) {
    item.record = { ...item.record, ...fields };
    this.handoverDirty = true;
  }

  async loadHandovers() {
    const records = Object.entries(await this.handoverOutbox.load());
    for (const [id, record] of records) {
      const receipt = record?.receipt;
      if (!UUID.test(id) || id !== id.toLowerCase() || receipt?.receiptId !== id || !HANDOVER_STATES.has(record.status)
        || (receipt.from !== null && (typeof receipt.from !== 'string' || !UUID.test(receipt.from)))
        || (receipt.at !== null && isoOf(receipt.at) !== receipt.at)
        || ![record.attempts, record.firstSeenAt, record.retryAt].every(Number.isSafeInteger)
        || (record.status === 'unknown' && !validIssue(record.issue))) throw new Error('HANDOVER_OUTBOX_INVALID');
    }
    for (const [, record] of records) this.rememberHandover(record);
    this.handoverLoaded = true;
  }

  async saveHandovers() {
    if (!this.handoverDirty) return;
    this.handoverDirty = false;
    try { await this.handoverOutbox?.save(Object.fromEntries([...this.handovers].map(([id, item]) => [id, item.record]))); }
    catch (error) { this.handoverDirty = true; throw error; }
  }

  delayHandover(item, status, delay) {
    item.nextAt = this.handoverClock() + delay;
    this.updateHandover(item, { status, retryAt: this.clock() + delay });
  }

  exhaustHandover(item) {
    this.delayHandover(item, 'undelivered', HANDOVER_RECOVERY_MS);
    const id = item.record.receipt.receiptId;
    void this.say(`handover-undelivered:${id}`, '自动接班评论未送达', `回执 ${id} 的评论尚未送达算力面板。伴随进程会在后台继续补发。`);
  }

  // One due receipt per advisory pass. The short retry budget is followed by one recovery attempt per cooldown.
  async handoverStep() {
    if (this.handoverBusy) return;
    this.handoverBusy = true;
    try {
      if (!this.handoverLoaded) await this.loadHandovers();
      const now = this.handoverClock();
      for (const [id, item] of this.handovers) {
        const { status, attempts, retryAt, receipt } = item.record;
        if (status === 'delivered') {
          if (this.clock() - retryAt >= HANDOVER_DEDUP_MS) { this.handovers.delete(id); this.handoverDirty = true; }
          continue;
        }
        if (status === 'pending' && (attempts >= HANDOVER_MAX_ATTEMPTS || now >= item.deadline)) {
          this.exhaustHandover(item);
          continue;
        }
        if (now < item.nextAt) continue;
        if (status === 'pending') this.updateHandover(item, { attempts: attempts + 1 });
        await this.saveHandovers();
        const deadline = status === 'pending' ? item.deadline : now + HANDOVER_RETRY_WINDOW_MS;
        const delivered = await this.relayHandover(receipt, deadline, item);
        if (delivered) {
          this.delayHandover(item, 'delivered', 0);
          await this.memory.set(`auto-handover:${id}`, this.clock());
        } else if (item.record.status === 'pending' && (item.record.attempts >= HANDOVER_MAX_ATTEMPTS || this.handoverClock() >= deadline)) {
          this.exhaustHandover(item);
        } else {
          const delay = status !== 'pending' && status === item.record.status ? HANDOVER_RECOVERY_MS : HANDOVER_RETRY_MS;
          this.delayHandover(item, item.record.status, delay);
        }
        break;
      }
      await this.saveHandovers();
    } catch { /* Keep dirty state for the next advisory pass. A failed intent write prevents POST. */ }
    finally { this.handoverBusy = false; }
  }

  async say(key, title, body) {
    if (this.alertsInFlight.has(key)) return;
    this.alertsInFlight.add(key);
    try {
      if (await this.memory.get(key)) return;
      await this.memory.set(key, this.clock());
      await this.notify(key, title, body);
    } catch { /* advisory */ }
    finally { this.alertsInFlight.delete(key); }
  }

  async relayHandover(h, deadline, item) {
    const marker = HANDOVER_MARKER(h.receiptId);
    const beforePost = item.record;
    try {
      // An empty list can precede a late commit. Only a positive marker read settles a prior unknown POST.
      if (beforePost.status === 'unknown') return (await this.handover.commentExists(beforePost.issue, marker)) === true;
      if (await this.memory.get(`auto-handover:${h.receiptId}`)) return true;
      if (this.handoverClock() >= deadline) return false;
      const login = await this.handover.ownerLogin();
      if (!login || this.handoverClock() >= deadline) return false;
      const issue = await this.handover.panelIssue();
      if (!validIssue(issue) || this.handoverClock() >= deadline) return false;
      const seen = await this.handover.commentExists(issue, marker);
      if (seen !== false) return seen === true;
      if (this.handoverClock() >= deadline) return false;
      // Persist the intent before sending. After a crash, reconcile on the issue the POST targeted.
      this.updateHandover(item, { status: 'unknown', issue });
      try { await this.saveHandovers(); }
      catch { this.updateHandover(item, beforePost); return false; }
      if (this.handoverClock() >= deadline) { this.updateHandover(item, beforePost); return false; }
      const result = await this.handover.comment(issue, handoverComment(h, login, this.nodeName));
      if (result === false) this.updateHandover(item, beforePost);
      return result === true;
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
      return validIssue(n) ? n : null;
    },
    async commentExists(issue, marker) {
      const r = await api(['--method', 'GET', '--paginate', `repos/${repo}/issues/${issue}/comments?per_page=100`], `[.[] | select((.body // "") | contains("${marker}"))] | length`);
      const counts = String(r.stdout ?? '').trim();
      if (r.code !== 0 || !/^\d+(?:\s+\d+)*$/.test(counts)) return null;
      return counts.split(/\s+/).some(x => Number(x) > 0);
    },
    async comment(issue, body) {
      const r = await api(['--include', '--method', 'POST', `repos/${repo}/issues/${issue}/comments`, '-f', `body=${body}`]);
      if (COMMENT_NOT_STARTED.has(r.refused)) return false;
      if (r.timedOut || r.refused) return null;
      const status = parseIncluded(r.stdout)?.status;
      if (status === 201) return true;
      return COMMENT_REJECTED.has(status) ? false : null;
    },
  };
}
