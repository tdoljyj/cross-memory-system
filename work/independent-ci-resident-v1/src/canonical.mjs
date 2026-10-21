// Canonical JSON, digests and strict shape checks shared by every resident module.
// Pure: no I/O. Inputs are untrusted data; every check fails closed with a stable code.
import { createHash } from 'node:crypto';

export class ResidentError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export const fail = (code, detail) => { throw new ResidentError(code, detail); };
export const check = (condition, code, detail) => { if (!condition) fail(code, detail); };

export const HEX40 = /^[0-9a-f]{40}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

function canonicalValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    check(Number.isFinite(value), 'NON_FINITE_NUMBER_REFUSED');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    check(proto === Object.prototype || proto === null, 'PLAIN_OBJECT_REQUIRED');
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  fail('UNSUPPORTED_JSON_VALUE');
}

export const canonicalJson = value => JSON.stringify(canonicalValue(value));
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const digest = value => sha256(Buffer.from(canonicalJson(value), 'utf8'));

// Parse a small untrusted JSON document: bounded size, UTF-8, no BOM games, plain object result.
export function parseBoundedJson(bytes, maximum, code = 'UNTRUSTED_JSON_REFUSED') {
  check(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, code, 'bytes');
  check(bytes.length > 0 && bytes.length <= maximum, code, 'size');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(code, 'utf8'); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let value;
  try { value = JSON.parse(text); } catch { fail(code, 'json'); }
  check(value !== null && typeof value === 'object' && !Array.isArray(value), code, 'object');
  return value;
}

// Exact key set: refuses unknown keys so an untrusted record can never smuggle a path or command.
export function exactKeys(value, keys, code) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), code, 'object');
  const actual = Object.keys(value).sort().join('|');
  check(actual === [...keys].sort().join('|'), code, 'keys');
}

export const isoNow = clock => new Date(clock()).toISOString();
