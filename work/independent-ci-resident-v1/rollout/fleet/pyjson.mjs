// Python's json module, as far as the ported tools use it (rollout/fleet, Decision b5d041d2 v2): the node has no Python, and the
// assembler must write the same bytes the Python tools wrote and hash the same canonical forms the frozen Linux tool hashes.
//   pyLoads(text)        json.loads: an int stays a JS number (refused beyond 2^53), a float becomes a PyFloat (so that it is written
//                        back as Python writes it: 2.0 stays "2.0"); NaN/Infinity and lone surrogates are refused.
//   pyDumps(v, opts)     json.dumps(v, sort_keys, separators, ensure_ascii, indent) for dict/list/str/int/float/bool/None.
//   pyCanonical(v)       json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)  (rconfig.canonical, the tool's canonical)
//   pyEqual(a, b)        Python == on loaded values (1 == 1.0; True == 1 is not needed and is treated as unequal).
export class PyFloat {
  constructor(value) { this.value = value; Object.freeze(this); }
}

const fail = (code, detail) => { throw Object.assign(new Error(detail === undefined ? code : `${code} ${detail}`), { code, detail }); };

export function pyLoads(text) {
  if (typeof text !== 'string') text = Buffer.from(text).toString('utf8');
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; const out = {}; ws();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        ws(); if (text[i] !== '"') fail('PY_JSON_REFUSED', 'key');
        const k = str(); ws();
        if (text[i++] !== ':') fail('PY_JSON_REFUSED', 'colon');
        const v = value();
        Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return out; }
        fail('PY_JSON_REFUSED', 'object');
      }
    }
    if (c === '[') {
      i++; const out = []; ws();
      if (text[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value()); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return out; }
        fail('PY_JSON_REFUSED', 'array');
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail('PY_JSON_REFUSED', 'value');
    i += m[0].length;
    if (m[1] === undefined && m[2] === undefined) {
      const n = Number(m[0]);
      if (!Number.isSafeInteger(n)) fail('PY_JSON_INT_OUT_OF_RANGE', m[0]);
      return n;
    }
    const f = Number(m[0]);
    if (!Number.isFinite(f)) fail('PY_JSON_REFUSED', 'float');
    return new PyFloat(f);
  };
  const str = () => {
    i++; let out = '';
    for (;;) {
      const c = text[i];
      if (c === undefined) fail('PY_JSON_REFUSED', 'string');
      if (c === '"') { i++; break; }
      if (c < ' ') fail('PY_JSON_REFUSED', 'control');
      if (c !== '\\') { out += c; i++; continue; }
      const e = text[i + 1];
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
      if (simple !== undefined) { out += simple; i += 2; continue; }
      if (e !== 'u' || !/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('PY_JSON_REFUSED', 'escape');
      out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6;
    }
    if (!out.isWellFormed()) fail('PY_JSON_REFUSED', 'surrogate');
    return out;
  };
  const v = value(); ws();
  if (i !== text.length) fail('PY_JSON_REFUSED', 'trailing');
  return v;
}

// repr(float): the shortest round-trip digits, fixed notation for 1e-4 <= |x| < 1e16, else d.ddde+XX.
export function pyFloatRepr(x) {
  if (!Number.isFinite(x)) fail('PY_JSON_REFUSED', 'float');
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, expText] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const exp = Number(expText);
  const sign = x < 0 ? '-' : '';
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      const int = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
      const frac = digits.slice(exp + 1);
      return `${sign}${int}.${frac || '0'}`;
    }
    return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  }
  const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

function strAscii(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += `\\u${(0xd800 + (v >> 10)).toString(16)}\\u${(0xdc00 + (v & 0x3ff)).toString(16)}`;
    } else out += `\\u${cp.toString(16).padStart(4, '0')}`;
  }
  return out + '"';
}

function strUnicode(s) {
  if (!s.isWellFormed()) fail('PY_JSON_REFUSED', 'surrogate');
  return JSON.stringify(s);   // the same escapes as Python with ensure_ascii=False (", \, \b\f\n\r\t, other < 0x20 as \u00xx)
}

// Python sorts str keys by code point; JS compares UTF-16 code units (different only around surrogates).
export function codePointCompare(a, b) {
  const x = [...a], y = [...b];
  for (let k = 0; k < Math.min(x.length, y.length); k++) {
    const d = x[k].codePointAt(0) - y[k].codePointAt(0);
    if (d) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export function pyDumps(value, { sortKeys = false, separators = null, ensureAscii = true, indent = null } = {}) {
  const [itemSep, keySep] = separators ?? (indent === null ? [', ', ': '] : [',', ': ']);
  const s = ensureAscii ? strAscii : strUnicode;
  const enc = (v, level) => {
    if (v === null) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (v instanceof PyFloat) return pyFloatRepr(v.value);
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) fail('PY_JSON_NUMBER_REFUSED', String(v));
      return String(v);
    }
    if (typeof v === 'string') return s(v);
    const nl = indent === null ? '' : '\n' + ' '.repeat(indent * (level + 1));
    const close = indent === null ? '' : '\n' + ' '.repeat(indent * level);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return '[' + nl + v.map(x => enc(x, level + 1)).join(itemSep + nl) + close + ']';
    }
    if (typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) fail('PY_JSON_REFUSED', 'object');
      let keys = Object.keys(v);
      if (keys.length === 0) return '{}';
      if (sortKeys) keys = [...keys].sort(codePointCompare);
      return '{' + nl + keys.map(k => s(k) + keySep + enc(v[k], level + 1)).join(itemSep + nl) + close + '}';
    }
    return fail('PY_JSON_REFUSED', typeof v);
  };
  return enc(value, 0);
}

export const pyCanonical = v => pyDumps(v, { sortKeys: true, separators: [',', ':'], ensureAscii: false });

export function pyEqual(a, b) {
  const num = v => (v instanceof PyFloat ? v.value : typeof v === 'number' ? v : undefined);
  if (num(a) !== undefined || num(b) !== undefined) return num(a) !== undefined && num(a) === num(b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, k) => pyEqual(x, b[k]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && pyEqual(a[k], b[k]));
}

// copy.deepcopy / json.loads(json.dumps(x)) of a loaded value.
export const pyCopy = v => (v instanceof PyFloat || v === null || typeof v !== 'object' ? v
  : Array.isArray(v) ? v.map(pyCopy) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pyCopy(x)])));
