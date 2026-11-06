// The node command signature protocol. Since unified scheduling 2B it is imported by the
// CI node gateway (ci-node-gateway-v1.ts), which owns the transport and the database call.
// A mathematical signature check grants no execution authority and consumes no nonce.
export const CI_SIGNATURE_PROTOCOL = 'clued.ci-node-command/1';
const MAX_BYTES = 65536;
// A payload may carry a full 64 KiB sealed-drop ciphertext as base64 (Stage 1 cap).
export const CI_MAX_PAYLOAD_BYTES = 131072;
const MAX_NODES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OPERATIONS = new Set([
  'node_registration', 'node_heartbeat', 'job_started', 'job_release',
  'stage8_try_begin', 'result_register', 'publish_prepare', 'publish_observe',
  'green_transition', 'train_front_set', 'train_sweep_confirm',
  'sealed_drop_send', 'sealed_drop_take',
  // Unified scheduling 2B.
  'qualification_report', 'nonce_issue', 'job_lease', 'job_renew', 'green_mirror_append',
  // Unified scheduling 2A (T2A-2): pull scheduling.
  'job_lease_next',
]);
// Operations without a job: everything else names its job and execution generation.
const JOBLESS = new Set([
  'node_registration', 'node_heartbeat', 'qualification_report', 'train_sweep_confirm', 'green_mirror_append',
  'job_lease_next',
]);
const DRAINING_SETTLEMENT = new Set([
  'node_heartbeat', 'job_release', 'result_register', 'publish_observe', 'green_transition',
  'job_renew', 'nonce_issue', 'green_mirror_append',
]);
// Accepted without a current qualification: the report that creates one, and a
// publisher's mirror records (a draining publisher must record how its greens end).
const WITHOUT_QUALIFICATION = new Set(['qualification_report', 'green_mirror_append']);
const PUBLISHER_ONLY = new Set([
  'publish_prepare', 'publish_observe', 'green_transition', 'train_sweep_confirm', 'sealed_drop_take', 'green_mirror_append',
]);
type JsonObject = { [key: string]: unknown };
export type CiSignatureError = 'INPUT_INVALID' | 'SIGNATURE_INVALID' | 'PRINCIPAL_INVALID'
  | 'SCOPE_DENIED' | 'STALE_VERSION' | 'COMMAND_EXPIRED' | 'TRUST_LOOKUP_FAILED';
class InvalidCommand extends Error {
  constructor(readonly code: CiSignatureError) { super(code); }
}
function invalid(code: CiSignatureError = 'INPUT_INVALID'): never { throw new InvalidCommand(code); }
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as JsonObject;
}
function exact(value: JsonObject, keys: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  for (const key of keys) {
    if (!Object.hasOwn(value, key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) invalid();
  }
}
function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) invalid();
  return value;
}
function scalarText(value: string): void {
  // Reject unpaired UTF-16 surrogates so different inputs cannot share replacement bytes.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid();
  }
}
// Versioned subset: Unicode scalar strings, safe integers only, UTF-16 sorted object
// keys, no toJSON/prototypes/accessors, max depth 16. This is not general RFC8785.
export function ciCanonicalJson(value: unknown, maxBytes: number = MAX_BYTES): string {
  let count = 0;
  let characters = 0;
  const emit = (text: string): string => {
    characters += text.length;
    if (characters > maxBytes) invalid();
    return text;
  };
  const visit = (entry: unknown, depth: number): string => {
    if (++count > MAX_NODES || depth > 16) invalid();
    if (entry === null) return emit('null');
    if (typeof entry === 'boolean') return emit(entry ? 'true' : 'false');
    if (typeof entry === 'number') { integer(entry, -Number.MAX_SAFE_INTEGER); return emit(String(entry)); }
    if (typeof entry === 'string') {
      if (entry.length > maxBytes) invalid();
      scalarText(entry); return emit(JSON.stringify(entry));
    }
    if (Array.isArray(entry)) {
      if (entry.length > 256 || Object.getPrototypeOf(entry) !== Array.prototype
        || Reflect.ownKeys(entry).length !== entry.length + 1) invalid();
      emit('[]' + ','.repeat(Math.max(0, entry.length - 1)));
      return '[' + Array.from({ length: entry.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
        return visit(descriptor.value, depth + 1);
      }).join(',') + ']';
    }
    const record = object(entry);
    const keys = Reflect.ownKeys(record);
    if (keys.length > 256 || keys.some(key => typeof key !== 'string')) invalid();
    emit('{}' + ','.repeat(Math.max(0, keys.length - 1)));
    return '{' + (keys as string[]).sort().map(key => {
      scalarText(key);
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      return emit(JSON.stringify(key) + ':') + visit(descriptor.value, depth + 1);
    }).join(',') + '}';
  };
  const result = visit(value, 0);
  if (new TextEncoder().encode(result).byteLength > maxBytes) invalid();
  return result;
}
async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function base64url(value: unknown, length: number): Uint8Array<ArrayBuffer> {
  const text = string(value, /^[A-Za-z0-9_-]+$/);
  if (text.length !== Math.ceil(length * 4 / 3)) invalid();
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length !== length || btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') !== text) invalid();
  return bytes;
}
function publicKey(value: unknown): JsonWebKey {
  const key = object(value);
  exact(key, ['kty', 'crv', 'x', 'y']);
  if (key.kty !== 'EC' || key.crv !== 'P-256') invalid();
  base64url(key.x, 32); base64url(key.y, 32);
  return { kty: 'EC', crv: 'P-256', x: String(key.x), y: String(key.y) };
}
export async function ciIdentityFingerprint(key: unknown): Promise<string> {
  return digest(ciCanonicalJson(publicKey(key)));
}
export type CiAuthenticatedPrincipal = Readonly<{
  user_id: string; project_id: string; binding_id: string; binding_generation: number;
}>;
export type CiTrustedNodeSnapshot = Readonly<{
  node_id: string; user_id: string; project_id: string; binding_id: string;
  binding_generation: number; version: number; key_version: number;
  identity_fingerprint: string; identity_public_jwk: unknown;
  state: string; qualification_verified: boolean; publisher_approved: boolean;
  binding_expires_at_ms: number; qualification_expires_at_ms: number;
}>;
type Command = Readonly<{
  protocol: string; operation: string; user_id: string; project_id: string; node_id: string;
  binding_id: string; binding_generation: number; node_version: number; key_version: number;
  key_fingerprint: string; payload_sha256: string; nonce: string;
  job_id: string | null; execution_generation: number; train_generation: number;
  issued_at_ms: number; expires_at_ms: number; signature: string;
}>;
const COMMAND_KEYS = [
  'protocol', 'operation', 'user_id', 'project_id', 'node_id', 'binding_id',
  'binding_generation', 'node_version', 'key_version', 'key_fingerprint',
  'payload_sha256', 'nonce', 'job_id', 'execution_generation', 'train_generation',
  'issued_at_ms', 'expires_at_ms', 'signature',
] as const;
function command(value: unknown): Command {
  const input = object(value); exact(input, COMMAND_KEYS);
  if (input.protocol !== CI_SIGNATURE_PROTOCOL || typeof input.operation !== 'string'
    || !OPERATIONS.has(input.operation)) invalid();
  for (const key of ['user_id', 'project_id', 'node_id', 'binding_id']) string(input[key], UUID);
  for (const key of ['binding_generation', 'node_version', 'key_version']) integer(input[key], 1);
  for (const key of ['execution_generation', 'train_generation', 'issued_at_ms', 'expires_at_ms']) integer(input[key]);
  for (const key of ['key_fingerprint', 'payload_sha256']) string(input[key], SHA256);
  base64url(input.nonce, 32); base64url(input.signature, 64);
  if (input.job_id !== null) string(input.job_id, UUID);
  if (JOBLESS.has(input.operation) !== (input.job_id === null)) invalid();
  if (input.job_id !== null && integer(input.execution_generation) < 1) invalid();
  if (integer(input.expires_at_ms) <= integer(input.issued_at_ms)
    || integer(input.expires_at_ms) - integer(input.issued_at_ms) > 120000) invalid();
  return input as Command;
}
export function ciCommandSigningBytes(input: unknown): Uint8Array<ArrayBuffer> {
  const parsed = command(input);
  const { signature: _signature, ...unsigned } = parsed;
  void _signature;
  return new TextEncoder().encode(ciCanonicalJson(unsigned));
}
function matches(node: CiTrustedNodeSnapshot | null, input: Command, principal: CiAuthenticatedPrincipal, now: number): CiTrustedNodeSnapshot {
  if (!node || node.node_id !== input.node_id || node.user_id !== principal.user_id
    || node.binding_id !== principal.binding_id || node.binding_generation !== principal.binding_generation) invalid('PRINCIPAL_INVALID');
  if (node.project_id !== principal.project_id) invalid('SCOPE_DENIED');
  if (node.version !== input.node_version || node.key_version !== input.key_version
    || node.identity_fingerprint !== input.key_fingerprint) invalid('STALE_VERSION');
  // A qualification report is how an approved (active) node becomes qualified; a
  // mirror record needs only an approved publisher on a live Binding.
  const unqualified = WITHOUT_QUALIFICATION.has(input.operation);
  if ((node.state !== 'active' && !(node.state === 'draining' && DRAINING_SETTLEMENT.has(input.operation)))
    || !Number.isFinite(node.binding_expires_at_ms) || node.binding_expires_at_ms <= now
    || (!unqualified && (!node.qualification_verified || !Number.isFinite(node.qualification_expires_at_ms)
      || node.qualification_expires_at_ms <= now))) invalid('PRINCIPAL_INVALID');
  if (PUBLISHER_ONLY.has(input.operation) && !node.publisher_approved) invalid('SCOPE_DENIED');
  if (input.issued_at_ms > now || input.expires_at_ms <= now) invalid('COMMAND_EXPIRED');
  return node;
}
export type CiSignatureObservation = Readonly<{
  kind: 'signature_observation_only'; node_id: string; node_version: number;
  key_version: number; key_fingerprint: string; operation: string; payload_sha256: string;
  nonce_sha256: string; verified_at_ms: number;
}>;
export async function verifyCiNodeCommand(
  input: unknown, payload: unknown, principal: CiAuthenticatedPrincipal,
  readTrustedNode: (nodeId: string) => Promise<CiTrustedNodeSnapshot | null>,
  now: () => number = Date.now,
): Promise<{ ok: true; observation: CiSignatureObservation } | { ok: false; code: CiSignatureError }> {
  try {
    // Snapshot caller-owned objects before the first await; no mutable input crosses it.
    const parsed = command(JSON.parse(ciCanonicalJson(input)));
    const canonicalPayload = ciCanonicalJson(payload, CI_MAX_PAYLOAD_BYTES);
    const actor = Object.freeze({ ...principal });
    for (const key of ['user_id', 'project_id', 'binding_id'] as const) string(actor[key], UUID);
    integer(actor.binding_generation, 1);
    if (parsed.user_id !== actor.user_id || parsed.project_id !== actor.project_id
      || parsed.binding_id !== actor.binding_id || parsed.binding_generation !== actor.binding_generation) invalid('PRINCIPAL_INVALID');
    if (await digest(canonicalPayload) !== parsed.payload_sha256) invalid('SIGNATURE_INVALID');
    const first = matches(await readTrustedNode(parsed.node_id), parsed, actor, integer(now()));
    const key = publicKey(first.identity_public_jwk);
    if (await ciIdentityFingerprint(key) !== parsed.key_fingerprint) invalid('SIGNATURE_INVALID');
    const imported = await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported,
      base64url(parsed.signature, 64), ciCommandSigningBytes(parsed));
    if (!verified) invalid('SIGNATURE_INVALID');
    // Crypto awaits can cross revocation/expiry. Re-read, never cache request principals.
    const nonceSha256 = await digest(parsed.nonce);
    const latest = await readTrustedNode(parsed.node_id);
    const checkedAt = integer(now());
    matches(latest, parsed, actor, checkedAt);
    return { ok: true, observation: Object.freeze({ kind: 'signature_observation_only',
      node_id: parsed.node_id, node_version: parsed.node_version, key_version: parsed.key_version,
      key_fingerprint: parsed.key_fingerprint, operation: parsed.operation,
      payload_sha256: parsed.payload_sha256, nonce_sha256: nonceSha256, verified_at_ms: checkedAt }) };
  } catch (error) {
    return { ok: false, code: error instanceof InvalidCommand ? error.code : 'TRUST_LOOKUP_FAILED' };
  }
}
