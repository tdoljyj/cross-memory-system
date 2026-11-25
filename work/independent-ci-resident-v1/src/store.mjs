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

// writeNew for a file the other side reads while it is still being written (DESIGN §31, Task 32d10618). writeNew creates the
// target and only then writes it, so a reader that opens it in between finds it empty or short. Here the bytes are written
// and flushed under a temporary name in the same directory first, and one rename gives them the target name: the target is
// either not there or complete. The temporary name starts with TEMP_PREFIX, which no reader's name pattern accepts.
//
// Create-only, as writeNew: an existing target is refused. fs.rename replaces an existing file on Windows, and a hard link
// (which would refuse) leaves the file with two names for a moment, which readBounded refuses as a changed identity; so the
// target is looked at before the rename. That leaves a window for a second writer of the very same name. It is for names
// that have one writer (request ids are UUIDs, a request has one answer, hint numbers come from one advisory lane); a
// claim that two writers contend for (the pump mark) stays with writeNew's exclusive create.
//
// Only for a directory the writer may rename in. The Owner's drop boxes (inbox\, requests\) are create-only for the Owner,
// who has neither DELETE nor DELETE_CHILD there (install-resident.ps1 Get-AclPlan): the readers of those wait instead
// (inbox.mjs, DESIGN §31.3).
export const TEMP_PREFIX = '.tmp-';
export const TEMP_FILE = /^\.tmp-[0-9a-f]{12}-/;
// A rename can fail for a moment on Windows while a scanner or indexer holds the new file open.
const RENAME_TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_MS = Object.freeze([20, 50, 100, 250, 500]);

export async function writeNewAtomic(file, value, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const bytes = Buffer.from(canonicalJson(value) + '\n', 'utf8');
  if (await exists(file)) fail('CREATE_ONLY_TARGET_EXISTS', path.basename(file));
  const temporary = path.join(path.dirname(file), `${TEMP_PREFIX}${nonce()}-${path.basename(file)}`);
  const handle = await fs.open(temporary, 'wx');
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await exists(file)) fail('CREATE_ONLY_TARGET_EXISTS', path.basename(file));
    for (let attempt = 0; ; attempt += 1) {
      try { await fs.rename(temporary, file); break; } catch (error) {
        if (!RENAME_TRANSIENT.has(error?.code) || attempt >= RENAME_RETRY_MS.length) throw error;
        await sleep(RENAME_RETRY_MS[attempt]);
      }
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => {}); // a failed write leaves no temporary file behind
    throw error;
  }
  return sha256(bytes);
}

// Temporary files a crash left behind (older than the minimum age: a write that is still going on is never touched). Best
// effort, in the directory the caller writes to; a directory it may not delete in leaves them alone.
export async function sweepTemp(dir, { olderThanMs = 3_600_000, clock = Date.now } = {}) {
  let names;
  try { names = await fs.readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!TEMP_FILE.test(name)) continue;
    try {
      const stat = await fs.lstat(path.join(dir, name));
      if (!stat.isFile() || clock() - stat.mtimeMs < olderThanMs) continue;
      await fs.unlink(path.join(dir, name));
      removed += 1;
    } catch { /* not ours to delete, or already gone */ }
  }
  return removed;
}

// Bounded read of a file someone else may control: one handle, the size and type come from that
// handle (no lstat/readFile gap), links and multi-link files are refused. Separate 'empty'
// and 'size' errors let callers distinguish an unwritten file from an oversized one.
export async function readBounded(file, maximum, code = 'BOUNDED_READ_REFUSED') {
  const link = await fs.lstat(file);
  check(link.isFile() && !link.isSymbolicLink(), code, 'type');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.nlink === 1 && stat.ino === link.ino, code, 'identity');
    check(stat.size > 0, code, 'empty');
    check(stat.size <= maximum, code, 'size');
    // Most ledger records are small. Read their observed size plus a byte to detect growth.
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
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
