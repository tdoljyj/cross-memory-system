// Pure journal validation/replay. No network, credentials or authorization.
// Source provenance must come from the authenticated reader outside this module.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const STATUSES = new Set(['ACTIVE','DRAINING','RELEASED','EXPIRED','SUPERSEDED','DELETED']);
const failure = reason => ({ status: 'NOT_MEASURED', value: null, reason, official_metric: false, provenance_verified: false });

// PostgreSQL emits microseconds. Preserve them for FIFO ordering and duration
// arithmetic rather than letting Date.parse silently collapse equal milliseconds.
export function timestampMicros(text) {
  if (typeof text !== 'string') throw new Error('timestamp_invalid');
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(text);
  if (!m) throw new Error('timestamp_invalid');
  const base = Date.parse(m[1] + m[3]);
  if (!Number.isFinite(base)) throw new Error('timestamp_invalid');
  const offset = m[3] === 'Z' ? 0 : (m[3][0] === '+' ? 1 : -1) *
    (Number(m[3].slice(1,3))*60 + Number(m[3].slice(4,6)));
  if (new Date(base + offset*60000).toISOString().slice(0,19) !== m[1]) throw new Error('timestamp_invalid');
  return BigInt(base) * 1000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}
const optionalTime = text => text === null ? null : timestampMicros(text);
const max = (...values) => values.filter(v => v !== null).reduce((a,b) => a > b ? a : b);
const min = (...values) => values.filter(v => v !== null).reduce((a,b) => a < b ? a : b);
const seconds = value => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 86400) throw new Error('policy_clock_invalid');
  return BigInt(value) * 1000000n;
};

export function validateJournal(wire, options = {}) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return failure('options_invalid');
    const { expectedSourceDigest, expectedStream } = options;
    if (typeof wire !== 'string' || Buffer.byteLength(wire, 'utf8') > 32 * 1024 * 1024)
      return failure('raw_journal_limit_or_type');
    const p = JSON.parse(wire);
    if (!SHA.test(expectedSourceDigest ?? '') || p.source_digest !== expectedSourceDigest ||
        !UUID.test(p.stream_id ?? '') || (expectedStream && p.stream_id !== expectedStream))
      return failure('source_or_stream_mismatch');
    if (p.status !== 'ok' || p.after_sequence !== 0 || !Number.isSafeInteger(p.end_sequence) ||
        p.end_sequence < 1 || p.end_sequence > 100000 || !Array.isArray(p.events) ||
        p.events.length !== p.end_sequence || p.has_more !== false || p.next_sequence !== p.end_sequence)
      return failure('journal_incomplete');
    const groups = [], seenTransactions = new Set(); let last = null, group;
    for (let index = 0; index < p.events.length; index++) {
      const e = p.events[index];
      if (e.sequence !== index + 1 || e.source_digest !== expectedSourceDigest ||
          !/^[0-9]{1,20}$/.test(e.transaction_id ?? '') ||
          !['policy','claim','queue_marker','admission_receipt'].includes(e.kind) ||
          typeof e.context_key !== 'string' || typeof e.object_key !== 'string' ||
          !e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload))
        return failure('event_identity_or_sequence_invalid');
      const at = timestampMicros(e.recorded_at);
      if (last !== null && at < last) return failure('event_time_regression');
      last = at;
      if (group?.transaction_id !== e.transaction_id) {
        if (seenTransactions.has(e.transaction_id)) return failure('transaction_interleaved');
        seenTransactions.add(e.transaction_id);
        group = { transaction_id: e.transaction_id, observed_at: at, events: [] }; groups.push(group);
      }
      group.observed_at = at; group.events.push(e);
    }
    if (groups[0]?.events[0]?.kind !== 'policy') return failure('initial_policy_missing');
    return { status: 'INTEGRITY_VALIDATED', groups, stream_id: p.stream_id,
      source_digest: p.source_digest, official_metric: false,
      observed_through: groups.at(-1).observed_at,
      timestamp_semantics: 'transaction-final server observation; not commit wall-clock',
      provenance_verified: false };
  } catch { return failure('journal_malformed'); }
}

export function emptyReplayState() { return { claims: new Map(), markers: new Map(), policy: null }; }
export function applyTransaction(state, group) {
  // Validate on a copy, then expose the entire group atomically to callers.
  const next = { claims: new Map(state.claims), markers: new Map(state.markers), policy: state.policy };
  for (const e of group.events) {
    const p = e.payload;
    if (e.kind === 'policy') {
      if (!p.profile) throw new Error('policy_projection_missing');
      seconds(p.profile.merge_slot_seconds); seconds(p.profile.merge_slot_running_seconds);
      seconds(p.profile.merge_slot_green_seconds); next.policy = p.profile;
    } else if (e.kind === 'claim') {
      if (!UUID.test(p.claim_id ?? '') || e.object_key !== p.claim_id || !STATUSES.has(p.status) ||
          !Number.isSafeInteger(p.fence) || p.fence < 1 || !Array.isArray(p.merge_refs) ||
          p.merge_refs.some(ref => typeof ref !== 'string' || !ref.startsWith('merge:')))
        throw new Error('claim_projection_invalid');
      const old = next.claims.get(p.claim_id);
      if (old && p.fence < old.fence) throw new Error('claim_fence_regression');
      timestampMicros(p.expires_at); optionalTime(p.merge_queued_at); optionalTime(p.merge_slot_at);
      optionalTime(p.merge_slot_ci_at);
      if (p.merge_slot_hard_cap_seconds !== null) seconds(p.merge_slot_hard_cap_seconds);
      next.claims.set(p.claim_id, p);
    } else if (e.kind === 'queue_marker') {
      if (e.object_key !== p.merge_ref || typeof p.merge_ref !== 'string' || !p.merge_ref.startsWith('merge:') ||
          !UUID.test(p.left_claim_id ?? '')) throw new Error('marker_projection_invalid');
      timestampMicros(p.head_left_at); timestampMicros(p.left_queued_at); next.markers.set(p.merge_ref.toLowerCase(), p);
    }
  }
  state.claims = next.claims; state.markers = next.markers; state.policy = next.policy;
}

/** Exact current FIFO formula, evaluated against a complete reconstructed state.
 * Includes expired waiting rows until the existing queue algorithm lapses/removes
 * them: do not replace the real policy with a naive lease-expiration filter.
 */
export function queueAt(state, queueRef, at) {
  if (!state.policy || typeof at !== 'bigint' || typeof queueRef !== 'string' || !queueRef.startsWith('merge:'))
    throw new Error('queue_input_invalid');
  const ref = queueRef.toLowerCase(), marker = state.markers.get(ref);
  let cursor = marker ? timestampMicros(marker.head_left_at) : null, head = null, depth = 0;
  const rows = [...state.claims.values()].filter(c => ['ACTIVE','DRAINING'].includes(c.status) &&
    c.merge_queued_at !== null && c.merge_refs.some(r => r.toLowerCase() === ref));
  rows.sort((a,b) => {
    const x = timestampMicros(a.merge_queued_at), y = timestampMicros(b.merge_queued_at);
    return x < y ? -1 : x > y ? 1 : a.claim_id < b.claim_id ? -1 : a.claim_id > b.claim_id ? 1 : 0;
  });
  for (const c of rows) {
    const joined = timestampMicros(c.merge_queued_at);
    if (marker) {
      const left = timestampMicros(marker.left_queued_at);
      if (joined < left || (joined === left && c.claim_id <= marker.left_claim_id)) continue;
    }
    if (!head) {
      const start = max(joined, cursor), ciAt = optionalTime(c.merge_slot_ci_at);
      const renewal = max(optionalTime(c.merge_slot_at), start) + seconds(state.policy.merge_slot_seconds);
      const ci = ciAt !== null && ciAt >= start ?
        c.merge_slot_ci_state === 'running' ? ciAt + seconds(state.policy.merge_slot_running_seconds) :
        c.merge_slot_ci_state === 'green' ? ciAt + seconds(state.policy.merge_slot_green_seconds) : null : null;
      const cap = c.merge_slot_hard_cap_seconds === null ? null : start + seconds(c.merge_slot_hard_cap_seconds);
      const until = min(max(renewal, ci), cap, timestampMicros(c.expires_at));
      if (until > at) { head = { claim_id: c.claim_id, since: start, until }; depth = 1; }
      else cursor = max(cursor, until, start);
    } else depth++;
  }
  return { depth, head };
}

// Calculation candidate only: timestamp and source qualification still belong
// to the formal collector. Never label this as an official measured metric.
export function queueDepthCandidate(validated, options = {}) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return failure('options_invalid');
    const { queueRef, start, end } = options;
    if (validated.status !== 'INTEGRITY_VALIDATED') return failure('journal_not_validated');
    const from = timestampMicros(start), to = timestampMicros(end);
    if (from >= to || to - from > 31n * 86400000000n) return failure('window_invalid');
    if (to > validated.observed_through) return failure('window_not_closed_by_source_observations');
    const state = emptyReplayState(); let index = 0;
    while (index < validated.groups.length && validated.groups[index].observed_at <= from)
      applyTransaction(state, validated.groups[index++]);
    if (!state.policy) return failure('initial_state_not_complete');
    const durations = new Map(); let at = from;
    while (at < to) {
      while (index < validated.groups.length && validated.groups[index].observed_at <= at)
        applyTransaction(state, validated.groups[index++]);
      const observed = queueAt(state, queueRef, at);
      let boundary = to;
      if (index < validated.groups.length && validated.groups[index].observed_at < boundary)
        boundary = validated.groups[index].observed_at;
      if (observed.head && observed.head.until < boundary) boundary = observed.head.until;
      if (boundary <= at) return failure('non_advancing_clock');
      durations.set(observed.depth, (durations.get(observed.depth) ?? 0n) + boundary - at); at = boundary;
    }
    const distribution = [...durations].sort(([a],[b]) => a-b);
    let elapsed = 0n, p95 = null;
    for (const [depth, duration] of distribution) {
      elapsed += duration; if (elapsed * 100n >= (to-from) * 95n) { p95 = depth; break; }
    }
    return { status: 'CALCULATION_CANDIDATE', value: p95, official_metric: false, provenance_verified: false,
      timestamp_semantics: validated.timestamp_semantics,
      distribution: distribution.map(([depth,duration]) => ({ depth, duration_us: duration.toString() })) };
  } catch { return failure('replay_or_clock_invalid'); }
}
