// Canonical JSON, redaction and normalized digests for S6 evidence
// (plan section 8). Evidence carries digests and extracts only: raw bodies,
// tokens, JWTs, confirmation tokens and passwords are never written.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function pretty(value) {
  const sort = (v) => (v === null || typeof v !== 'object') ? v : Array.isArray(v) ? v.map(sort)
    : Object.fromEntries(Object.keys(v).filter((key) => v[key] !== undefined).sort().map((key) => [key, sort(v[key])]));
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

// Secret-shaped strings. Everything matching is replaced before a value can
// reach an evidence file; `label()` gives a stable short digest instead.
const SECRET_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /clued_(bnd|cft|cwt|cpt)_[A-Za-z0-9_-]{16,}/g, // Binding and confirmation tokens
  /sb_(publishable|secret)_[A-Za-z0-9_-]{8,}/g, // Supabase API keys
];

export function label(secret) {
  return `sha256:${sha256(String(secret)).slice(0, 12)}`;
}

export function redact(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (match) => `<redacted:${label(match)}>`);
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (/^(confirmation_token|access_token|refresh_token|password|token|apikey|authorization)$/i.test(key)
        && typeof child === 'string') out[key] = `<redacted:${label(child)}>`;
      else out[key] = redact(child);
    }
    return out;
  }
  return value;
}

export function assertNoSecrets(text, where) {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) throw new Error(`secret-shaped value in ${where}`);
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX64 = /\b[0-9a-f]{64}\b/g;
const HEX32 = /\b[0-9a-f]{32}\b/g; // md5 state-snapshot digests over volatile rows
const SYSID = /^\d{15,20}$/; // PostgreSQL system_identifier (new cluster per db reset)
const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?\b/g;
const VOLATILE_KEYS = new Set(['duration_ms', 'pid', 'pgid', 'event_ids', 'event_id', 'at', 'elapsed_ms', 'startup_ms',
  'request_sha256', 'response_sha256', 'port', 'token_count', 'session_label', 'new_pid', 'killed_pid', 'killed_pgid',
  'w1_pid', 'w2_pid', 'p1_pid', 'p2_pid']);

// Normalizer. A uuid with a scenario alias becomes `<alias>`; any other uuid
// becomes `<uuid>`. 64-hex digests, ISO timestamps and volatile keys are
// replaced. Arrays are sorted by canonical form after normalization, because
// server-side orderings by random ids are not stable across runs.
export function normalizer(aliases = {}) {
  const byId = new Map(Object.entries(aliases).map(([name, id]) => [String(id).toLowerCase(), name]));
  const norm = (value, key) => {
    if (key && VOLATILE_KEYS.has(key)) return '<volatile>';
    if (typeof value === 'string') {
      if (SYSID.test(value)) return '<system_identifier>';
      return value
        .replace(UUID, (match) => (byId.has(match.toLowerCase()) ? `<${byId.get(match.toLowerCase())}>` : '<uuid>'))
        .replace(HEX64, '<hex64>')
        .replace(HEX32, '<hex32>')
        .replace(ISO, '<ts>')
        .replace(/sha256:[0-9a-f]{12}/g, 'sha256:<label>');
    }
    if (Array.isArray(value)) return value.map((child) => norm(child)).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, norm(child, childKey)]));
    }
    return value;
  };
  return norm;
}

// What the normalized digest keeps and drops (documented for reviewers).
export const NORMALIZATION = {
  keeps: ['scenario_id', 'steps[].n', 'steps[].channel', 'steps[].method', 'steps[].target (template)',
    'steps[].http_status (network errors collapsed)', 'steps[].extracted', 'assertions[].id', 'assertions[].expected',
    'assertions[].pass', 'result'],
  drops: ['steps[].ledger', 'steps[].request_sha256', 'steps[].response_sha256', 'steps[].duration_ms',
    'assertions[].text', 'assertions[].observed', 'notes', 'aliases (used only to name ids)', 'environment', 'code_binding'],
  replaces: ['aliased uuids -> <alias>', 'other uuids -> <uuid>', '64-hex -> <hex64>', '32-hex -> <hex32>',
    'ISO timestamps -> <ts>', 'PostgreSQL system identifiers', 'volatile keys (pids, ports, durations, event ids)'],
  arrays: 'sorted by canonical form after normalization',
  byte_integrity: 'SHA256SUMS over every evidence file (the seal)',
};

export function normalizedDigest(evidence) {
  const norm = normalizer(evidence.aliases ?? {});
  const core = {
    scenario_id: evidence.scenario_id,
    steps: evidence.steps.map((step) => ({ n: step.n, ...norm({ channel: step.channel, method: step.method,
      target_template: step.target,
      http_status: String(step.http_status).startsWith('network_error') ? 'network_error' : step.http_status,
      extracted: step.extracted ?? null }) })),
    assertions: evidence.assertions.map((item) => ({ id: item.id, ...norm({ expected: item.expected, pass: item.pass }) })),
    result: evidence.result,
  };
  return sha256(canonical(core));
}

export function writeJson(file, value) {
  const text = pretty(value);
  assertNoSecrets(text, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return sha256(text);
}

export function targetTemplate(target) {
  return String(target).replace(UUID, '{id}');
}
