import { createHash } from 'node:crypto';

const EVENT_KINDS = new Set(['error', 'trace', 'metric', 'log']);
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
const FORBIDDEN_KEY = /(authorization|cookie|oauth|token|secret|password|dsn|prompt|canonical[_-]?context|raw[_-]?user|user[_-]?id|subject[_-]?id|payload|body|content)/i;
const DEFAULT_SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._~+\/=-]+/i,
  /sk-[a-z0-9_-]{8,}/i,
  /oauth[_-]?code[:=][a-z0-9._~-]+/i,
  /https?:\/\/[^@\s]+@[^/\s]+/i,
  /-----begin [^-]+ private key-----/i
];

export const OBSERVABILITY_AUTHORITY = Object.freeze({
  canonical_write: false,
  event_authority: false,
  receipt_authority: false,
  evidence_authority: false,
  gate_authority: false,
  status_authority: false
});

function invariant(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function flattenStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) flattenStrings(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) flattenStrings(item, output);
  return output;
}

function containsSensitive(value, profile) {
  const joined = flattenStrings(value).join('');
  if (DEFAULT_SECRET_PATTERNS.some((pattern) => pattern.test(joined))) return true;
  return (profile.sensitive_markers || []).some((marker) => typeof marker === 'string' && marker.length >= 4 && joined.includes(marker));
}

function scrubValue(value, maxStringBytes) {
  if (typeof value === 'string') {
    const clean = value
      .replace(/bearer\s+[a-z0-9._~+\/=-]+/ig, '[REDACTED]')
      .replace(/sk-[a-z0-9_-]{8,}/ig, '[REDACTED]')
      .replace(/oauth[_-]?code[:=][a-z0-9._~-]+/ig, '[REDACTED]');
    return Buffer.byteLength(clean) > maxStringBytes ? clean.slice(0, maxStringBytes) + '[TRUNCATED]' : clean;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return '[UNSUPPORTED_REDACTED]';
}

export function validateObservabilityProfile(profile) {
  invariant(profile && profile.schema_version === 'clued.observability-profile/1', 'OBS_PROFILE_SCHEMA');
  invariant(profile.semantic_convention && profile.semantic_convention.version && profile.semantic_convention.digest, 'OBS_SEMANTIC_CONVENTION_REQUIRED');
  invariant(profile.resource && profile.resource.service_name && profile.resource.component && profile.resource.version && profile.resource.environment, 'OBS_RESOURCE_REQUIRED');
  invariant(Array.isArray(profile.allowed_attributes), 'OBS_ALLOWLIST_REQUIRED');
  invariant(profile.allowed_attributes.every((key) => typeof key === 'string' && !FORBIDDEN_KEY.test(key)), 'OBS_ALLOWLIST_FORBIDDEN_FIELD');
  invariant(profile.sampling && Number.isInteger(profile.sampling.seed), 'OBS_SAMPLING_SEED_REQUIRED');
  for (const kind of EVENT_KINDS) {
    invariant(Number.isFinite(profile.sampling[kind]) && profile.sampling[kind] >= 0 && profile.sampling[kind] <= 1, 'OBS_SAMPLING_RATIO_INVALID');
  }
  const limits = profile.rate_limit || {};
  invariant(Number.isInteger(limits.window_ms) && limits.window_ms > 0, 'OBS_RATE_WINDOW_INVALID');
  invariant(Number.isInteger(limits.max_per_window) && limits.max_per_window > 0, 'OBS_RATE_LIMIT_INVALID');
  invariant(Number.isInteger(limits.queue_max_events) && limits.queue_max_events > 0, 'OBS_QUEUE_EVENTS_INVALID');
  invariant(Number.isInteger(limits.queue_max_bytes) && limits.queue_max_bytes > 0, 'OBS_QUEUE_BYTES_INVALID');
  invariant(Number.isInteger(limits.retry_budget) && limits.retry_budget >= 0 && limits.retry_budget <= 3, 'OBS_RETRY_BUDGET_INVALID');
  invariant(profile.provider && ['none', 'adapter'].includes(profile.provider.kind), 'OBS_PROVIDER_INVALID');
  if (profile.provider.kind === 'none') {
    invariant(!profile.provider.dsn && !profile.provider.endpoint && !profile.provider.secret_handle, 'OBS_PROVIDER_NONE_MUST_HAVE_ZERO_CONNECTION_CONFIG');
  } else {
    invariant(profile.provider.artifact_digest && profile.provider.adapter_id, 'OBS_PROVIDER_ADAPTER_PIN_REQUIRED');
  }
  return Object.freeze(structuredClone(profile));
}

export function minimalEnvelope(raw, profile) {
  invariant(raw && EVENT_KINDS.has(raw.event_kind), 'OBS_EVENT_KIND_INVALID');
  invariant(raw.timestamp && Number.isFinite(Date.parse(raw.timestamp)), 'OBS_TIMESTAMP_INVALID');
  invariant(raw.tenant_id && raw.trace_id && raw.span_id, 'OBS_CORRELATION_REQUIRED');
  invariant(SEVERITIES.has(raw.severity), 'OBS_SEVERITY_INVALID');
  if (containsSensitive({ attributes: raw.attributes, chunks: raw.chunks, exception: raw.exception }, profile)) {
    return { status: 'QUARANTINED_SENSITIVE', reason_code: 'sensitive_material_detected_before_cache_sampling_export' };
  }
  const allowed = new Set(profile.allowed_attributes);
  const attributes = {};
  for (const [key, value] of Object.entries(raw.attributes || {})) {
    if (!allowed.has(key) || FORBIDDEN_KEY.test(key)) continue;
    attributes[key] = scrubValue(value, profile.max_string_bytes || 256);
  }
  const correlation_hashes = {};
  for (const [key, value] of Object.entries(raw.correlation || {})) {
    if (!['run_id', 'step_id', 'attempt_id', 'evidence_id'].includes(key)) continue;
    correlation_hashes[key.replace('_id', '_ref')] = 'sha256:' + digest(profile.correlation_salt + ':' + key + ':' + value);
  }
  return {
    status: 'SCRUBBED',
    envelope: Object.freeze({
      schema_version: 'clued.observability-envelope/1',
      event_kind: raw.event_kind,
      timestamp: raw.timestamp,
      service: profile.resource.service_name,
      component: profile.resource.component,
      service_version: profile.resource.version,
      environment: profile.resource.environment,
      severity: raw.severity,
      trace_id: raw.trace_id,
      span_id: raw.span_id,
      correlation_hashes,
      attributes,
      semantic_convention: profile.semantic_convention.version,
      semantic_convention_digest: profile.semantic_convention.digest,
      authority: OBSERVABILITY_AUTHORITY
    })
  };
}

export class ObservabilityPort {
  constructor(profile, providerAdapter = null) {
    this.profile = validateObservabilityProfile(profile);
    this.providerAdapter = providerAdapter;
    this.queue = [];
    this.queueBytes = 0;
    this.windows = new Map();
    this.audit = [];
    this.counters = {
      accepted: 0,
      sampled_out: 0,
      rate_limited: 0,
      backpressure_dropped: 0,
      sensitive_quarantined: 0,
      provider_none: 0,
      provider_failures: 0,
      exported: 0
    };
  }

  samplingDecision(envelope) {
    if (envelope.event_kind === 'error' && envelope.severity === 'fatal') return true;
    const ratio = this.profile.sampling[envelope.event_kind];
    const sample = parseInt(digest(this.profile.sampling.seed + ':' + envelope.trace_id + ':' + envelope.event_kind).slice(0, 8), 16) / 0xffffffff;
    return sample < ratio;
  }

  rateDecision(envelope, nowMs) {
    const key = envelope.attributes.tenant_partition || 'tenant:' + digest(envelope.trace_id).slice(0, 12);
    const window = Math.floor(nowMs / this.profile.rate_limit.window_ms);
    const current = this.windows.get(key);
    if (!current || current.window !== window) {
      this.windows.set(key, { window, count: 1 });
      return true;
    }
    if (current.count >= this.profile.rate_limit.max_per_window) return false;
    current.count += 1;
    return true;
  }

  emit(raw, canonicalOutcome = null, nowMs = Date.parse(raw.timestamp)) {
    this.audit.push({ trace_id: raw.trace_id, stage: 'scrub_before_any_cache_sampling_or_export' });
    const scrubbed = minimalEnvelope(raw, this.profile);
    if (scrubbed.status !== 'SCRUBBED') {
      this.counters.sensitive_quarantined += 1;
      return Object.freeze({ accepted: false, status: scrubbed.status, canonical_outcome: canonicalOutcome });
    }
    const envelope = scrubbed.envelope;
    this.audit.push({ trace_id: raw.trace_id, stage: 'sample_after_scrub' });
    if (!this.samplingDecision(envelope)) {
      this.counters.sampled_out += 1;
      return Object.freeze({ accepted: false, status: 'SAMPLED_OUT', canonical_outcome: canonicalOutcome });
    }
    this.audit.push({ trace_id: raw.trace_id, stage: 'rate_limit_after_scrub' });
    if (!this.rateDecision(envelope, nowMs)) {
      this.counters.rate_limited += 1;
      return Object.freeze({ accepted: false, status: 'RATE_LIMITED', canonical_outcome: canonicalOutcome });
    }
    const bytes = Buffer.byteLength(canonical(envelope));
    if (this.queue.length >= this.profile.rate_limit.queue_max_events || this.queueBytes + bytes > this.profile.rate_limit.queue_max_bytes) {
      this.counters.backpressure_dropped += 1;
      return Object.freeze({ accepted: false, status: 'BACKPRESSURE_DROPPED', canonical_outcome: canonicalOutcome });
    }
    this.counters.accepted += 1;
    if (this.profile.provider.kind === 'none') {
      this.counters.provider_none += 1;
      return Object.freeze({ accepted: true, status: 'ACCEPTED_PROVIDER_NONE', canonical_outcome: canonicalOutcome, envelope });
    }
    this.queue.push(envelope);
    this.queueBytes += bytes;
    return Object.freeze({ accepted: true, status: 'QUEUED', canonical_outcome: canonicalOutcome, envelope });
  }

  async flush() {
    if (this.profile.provider.kind === 'none') return { status: 'PROVIDER_NONE', exported: 0, remaining: 0 };
    const batch = this.queue.splice(0);
    this.queueBytes = 0;
    if (!batch.length) return { status: 'EMPTY', exported: 0, remaining: 0 };
    let attempt = 0;
    while (attempt <= this.profile.rate_limit.retry_budget) {
      try {
        invariant(this.providerAdapter && typeof this.providerAdapter.export === 'function', 'OBS_PROVIDER_ADAPTER_MISSING');
        await this.providerAdapter.export(batch);
        this.counters.exported += batch.length;
        return { status: 'EXPORTED', exported: batch.length, remaining: 0 };
      } catch (error) {
        attempt += 1;
        this.counters.provider_failures += 1;
      }
    }
    return { status: 'DROPPED_AFTER_BOUNDED_RETRY', exported: 0, remaining: 0 };
  }

  snapshot() {
    return Object.freeze({
      authority: OBSERVABILITY_AUTHORITY,
      queue_events: this.queue.length,
      queue_bytes: this.queueBytes,
      counters: structuredClone(this.counters),
      audit: structuredClone(this.audit)
    });
  }
}
