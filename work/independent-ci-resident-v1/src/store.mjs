// Create-only file primitives for the resident state directory.
// Nothing here overwrites or deletes evidence: records are written once with exclusive create,
// and the only mutation of an existing file is a rename into an archive name that must not exist.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalJson, check, fail, sha256 } from './canonical.mjs';

export async function writeNew(file, value) {
  const bytes = Buffer.from(canonicalJson(value) + '\n', 'utf8');
  let handle;
  try {
    handle = await fs.open(file, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') fail('CREATE_ONLY_TARGET_EXISTS', path.basename(file));
    throw error;
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return sha256(bytes);
}

// Bounded read of a file someone else may control: one handle, the size and type come from that
// handle (no lstat/readFile gap), at most `maximum` bytes are ever read, links and multi-link
// files are refused. An empty file is refused as 'empty' and one too large as 'size': writeNew creates its file before
// it writes it, so a reader of a file that is still being written can find it empty or growing ('size-changed').
export async function readBounded(file, maximum, code = 'BOUNDED_READ_REFUSED') {
  const link = await fs.lstat(file);
  check(link.isFile() && !link.isSymbolicLink(), code, 'type');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.nlink === 1 && stat.ino === link.ino, code, 'identity');
    check(stat.size > 0, code, 'empty');
    check(stat.size <= maximum, code, 'size');
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, maximum + 1, 0);
    check(bytesRead === stat.size && bytesRead <= maximum, code, 'size-changed');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readJson(file, maximum = 4 * 1024 * 1024) {
  const bytes = await readBounded(file, maximum, 'STATE_RECORD_UNREADABLE');
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes), bytes: bytes.length };
}

export async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Rename one existing file or directory to a fresh archive name (never replacing anything).
// Only for directories the Owner's user context cannot write (the resident's own state).
export async function renameToNew(from, to) {
  check(await exists(from), 'ARCHIVE_SOURCE_MISSING', path.basename(from));
  check(!(await exists(to)), 'ARCHIVE_TARGET_EXISTS', path.basename(to));
  await fs.rename(from, to);
}

export const nonce = (bytes = 6) => randomBytes(bytes).toString('hex');

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  const stat = await fs.lstat(dir);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'STATE_DIRECTORY_REQUIRED', path.basename(dir));
}
