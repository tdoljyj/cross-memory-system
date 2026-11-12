// The smallest deterministic ustar this needs (rollout/fleet, Decision b5d041d2 v2): regular files only, sorted by path, mode 0644,
// uid/gid 0, mtime 0, no user or group name, no directory entries, two zero blocks at the end. The reader accepts exactly that and
// refuses everything else (links, directories, pax/GNU headers, bad checksums, absolute or climbing paths, names Windows would alias).
import fs from 'node:fs/promises';
import path from 'node:path';

const BLOCK = 512;
const MAX_SIZE = 8 ** 11 - 1;
const fail = (code, detail) => { throw Object.assign(new Error(detail === undefined ? code : `${code} ${detail}`), { code, detail }); };
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

// A path the reader (and an extraction on Windows) accepts: forward slashes, no empty/./.. part, no drive, no NUL or control
// character, no backslash or colon, no part ending in a dot or a blank, no device name.
export function safeTarPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 400 && p.isWellFormed() && !/[\x00-\x1f\\:*?"<>|]/.test(p) && !p.startsWith('/')
    && p.split('/').every(s => s !== '' && s !== '.' && s !== '..' && !/[. ]$/.test(s) && !RESERVED.test(s));
}

const octal = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';

function splitName(p) {
  const b = Buffer.from(p, 'utf8');
  if (b.length <= 100) return { name: b, prefix: Buffer.alloc(0) };
  for (let k = 0; k < b.length; k++) {
    if (b[k] !== 0x2f) continue;
    const prefix = b.subarray(0, k), name = b.subarray(k + 1);
    if (prefix.length <= 155 && name.length > 0 && name.length <= 100) return { name, prefix };
  }
  return fail('TAR_PATH_TOO_LONG', p);
}

function header(p, size) {
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(p);
  name.copy(h, 0);
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.fill(0x20, 148, 156);
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  prefix.copy(h, 345);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// entries: [{ path, data: Buffer }] -> the archive bytes (entries sorted by the UTF-8 bytes of their path).
export function writeTar(entries) {
  const seen = new Set();
  const parts = [];
  for (const e of [...entries].sort((a, b) => byteOrder(a.path, b.path))) {
    if (!safeTarPath(e.path)) fail('TAR_PATH_REFUSED', e.path);
    const key = e.path.toLowerCase();
    if (seen.has(key)) fail('TAR_PATH_TWICE', e.path);
    seen.add(key);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    if (data.length > MAX_SIZE) fail('TAR_FILE_TOO_LARGE', e.path);
    parts.push(header(e.path, data.length), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}

const field = (h, at, len) => { const s = h.subarray(at, at + len); const z = s.indexOf(0); return z < 0 ? s : s.subarray(0, z); };
const readOctal = (h, at, len, code) => {
  const t = field(h, at, len).toString('ascii').trim();
  if (!/^[0-7]{1,11}$/.test(t)) fail(code, 'number');
  return parseInt(t, 8);
};

// archive bytes -> [{ path, data }] in archive order. Strict: only what writeTar writes.
export function readTar(buf) {
  const out = [];
  const seen = new Set();
  let at = 0;
  for (;;) {
    if (at + BLOCK > buf.length) fail('TAR_TRUNCATED');
    const h = buf.subarray(at, at + BLOCK);
    if (h.every(x => x === 0)) {
      if (buf.length - at < 2 * BLOCK || !buf.subarray(at).every(x => x === 0)) fail('TAR_TRAILING_DATA');
      return out;
    }
    let sum = 0;
    for (let k = 0; k < BLOCK; k++) sum += k >= 148 && k < 156 ? 0x20 : h[k];
    if (readOctal(h, 148, 8, 'TAR_HEADER_REFUSED') !== sum) fail('TAR_CHECKSUM_MISMATCH');
    if (h.toString('ascii', 257, 263) !== 'ustar\0' || h.toString('ascii', 263, 265) !== '00') fail('TAR_HEADER_REFUSED', 'magic');
    const type = String.fromCharCode(h[156]);
    if (type !== '0' && type !== '\0') fail('TAR_ENTRY_TYPE_REFUSED', type === '2' || type === '1' ? 'link' : type);
    if (field(h, 157, 100).length !== 0) fail('TAR_ENTRY_TYPE_REFUSED', 'link');
    let name, prefix;
    try {
      const dec = new TextDecoder('utf-8', { fatal: true });
      name = dec.decode(field(h, 0, 100)); prefix = dec.decode(field(h, 345, 155));
    } catch { fail('TAR_PATH_REFUSED', 'utf8'); }
    const p = prefix ? `${prefix}/${name}` : name;
    if (!safeTarPath(p)) fail('TAR_PATH_REFUSED', p.slice(0, 200));
    if (seen.has(p.toLowerCase())) fail('TAR_PATH_TWICE', p);
    seen.add(p.toLowerCase());
    const size = readOctal(h, 124, 12, 'TAR_HEADER_REFUSED');
    const start = at + BLOCK;
    if (start + size > buf.length) fail('TAR_TRUNCATED', p);
    out.push({ path: p, data: buf.subarray(start, start + size) });
    at = start + Math.ceil(size / BLOCK) * BLOCK;
  }
}

// Writes every entry under dest (which must not exist yet), create-only, never outside dest.
export async function extractTar(entries, dest) {
  await fs.mkdir(dest, { recursive: false });
  const root = path.resolve(dest);
  for (const e of entries) {
    if (!safeTarPath(e.path)) fail('TAR_PATH_REFUSED', e.path);
    const file = path.resolve(root, ...e.path.split('/'));
    if (!file.startsWith(root + path.sep)) fail('TAR_PATH_REFUSED', e.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, e.data, { flag: 'wx' });
  }
}
