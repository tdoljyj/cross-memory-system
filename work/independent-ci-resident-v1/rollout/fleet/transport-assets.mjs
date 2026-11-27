// Encode alternatives from the exact, already verified Release tar bytes.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip as zip } from 'node:zlib';
import { previousTransportVersion, TRANSPORT, transportAssetNames } from './fetch.mjs';

const gzip = promisify(zip);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Find equal byte ranges even when tar entries or packed Git objects move.
// A rolling hash locates candidates. Only a byte-for-byte match becomes a COPY.
function encodeDelta(base, target) {
  const block = 128;
  const multiplier = 257;
  const anchors = new Map();
  const hash = (bytes, start) => {
    let value = 0;
    for (let i = start; i < start + block; i++) value = (Math.imul(value, multiplier) + bytes[i]) | 0;
    return value;
  };
  let leading = 1;
  for (let i = 1; i < block; i++) leading = Math.imul(leading, multiplier);
  for (let start = 0; start + block <= base.length; start += block) anchors.set(hash(base, start), start);

  const records = [];
  let size = 0;
  const add = (offset, length, bytes) => {
    if (length === 0) return;
    size += 8 + (bytes?.length ?? 0);
    if (size > TRANSPORT.patchMax) return;
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32LE(offset, 0);
    header.writeUInt32LE(length, 4);
    records.push(header);
    if (bytes) records.push(bytes);
  };
  let unmatched = 0;
  let at = 0;
  let rolling = hash(target, 0);
  while (at + block <= target.length) {
    const from = anchors.get(rolling);
    if (from === undefined || Buffer.compare(base.subarray(from, from + block), target.subarray(at, at + block)) !== 0) {
      if (at + block < target.length) {
        rolling = (Math.imul(rolling - Math.imul(target[at], leading), multiplier) + target[at + block]) | 0;
      }
      at++;
      continue;
    }
    let start = from, begin = at;
    while (start > 0 && begin > unmatched && base[start - 1] === target[begin - 1]) { start--; begin--; }
    let end = at + block, limit = Math.min(target.length, at + base.length - from);
    while (end < limit && base[from + end - at] === target[end]) end++;
    add(TRANSPORT.literal, begin - unmatched, target.subarray(unmatched, begin));
    add(start, end - begin);
    if (size > TRANSPORT.patchMax) return null;
    at = unmatched = end;
    if (at + block <= target.length) rolling = hash(target, at);
  }
  add(TRANSPORT.literal, target.length - unmatched, target.subarray(unmatched));
  return size <= TRANSPORT.patchMax ? Buffer.concat(records, size) : null;
}

export async function stageTransport({ repository, version, archiveSha256, archive, previous, stage }) {
  if (!archive.length || archive.length > TRANSPORT.archiveMax) return [];
  const assets = [];
  const common = { contract: TRANSPORT.contract, repository, version, archive_sha256: archiveSha256, archive_bytes: archive.length };
  async function stageRepresentation(kind, encoded, base) {
    const { meta, payload } = transportAssetNames(version, kind);
    const info = { ...common, kind, bytes: encoded.length, sha256: sha(encoded), ...(base ? { base } : {}) };
    for (const [name, bytes] of [[payload, encoded], [meta, JSON.stringify(info) + '\n']]) {
      const file = path.join(stage, name);
      await fs.writeFile(file, bytes, { flag: 'wx' });
      assets.push({ name, file });
    }
  }
  const whole = await gzip(archive, { level: 9 });
  if (whole.length < archive.length) await stageRepresentation('gzip', whole);
  if (previous && previous.version === previousTransportVersion(version)
    && previous.bytes.length > 0 && previous.bytes.length <= TRANSPORT.archiveMax && sha(previous.bytes) === previous.sha256) {
    const patch = encodeDelta(previous.bytes, archive);
    if (patch) {
      const encoded = await gzip(patch, { level: 9 });
      if (encoded.length <= TRANSPORT.deltaMax && encoded.length < Math.min(whole.length, archive.length)) {
        await stageRepresentation('delta', encoded,
          { version: previous.version, bytes: previous.bytes.length, sha256: previous.sha256 });
      }
    }
  }
  return assets;
}
