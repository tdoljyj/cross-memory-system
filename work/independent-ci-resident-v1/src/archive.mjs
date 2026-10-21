// Protocol archive: rename the bridge protocol records left in a formal spool into one fresh,
// uniquely named directory and prove the bytes did not change. Nothing is deleted or overwritten.
//
// Allow-list only (independent review X1): exactly the record pairs the bridge defines
// (protocol-job-bridge-v3/mailbox.mjs names; advance-functions.ps1 Archive-WindowsProtocol) plus
// outgoing/active.lock. There is no directory walk, so a junction planted under incoming/ is never
// followed; every leaf must be a plain single-link file within a size bound, and both parent
// directories must be real directories whose real path is the expected one, re-checked right before
// each rename. Effect journals (<64 hex>.json), observations.jsonl and anything else stay in place:
// exactly-once publication relies on them across batches.
//
// Production note: the Windows formal spool is writable by the Owner's user context, and Node cannot
// hold directory handles that forbid a parent swap. On the host the same allow-list is applied by
// the Source v2 handle-based tool (resident-v2/archive-windows-spool.ps1, built on the reviewed
// VerifyInstallFiles HoldMetadata/ExactPath primitives); this module is its reference and the
// offline implementation. It must never run elevated.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HEX64, check, isoNow } from './canonical.mjs';
import { exists, nonce, writeNew } from './store.mjs';

export const ARCHIVE_CONTRACT = 'clued.independent-ci.resident-protocol-archive/1';
const REASON = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_LEAF = 1024 * 1024;
const seq = prefix => Array.from({ length: 32 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);

// Windows view: outgoing = issue, response-NN, active.lock; incoming = result, blocked (bridge v4: the
// Linux worker's clean refusal), challenge-NN. Linux view is the mirror image (see linux/bin/clued-ci-resident-linux).
export const WINDOWS_PROTOCOL = Object.freeze({
  incoming: ['result', 'blocked', ...seq('challenge')].flatMap(n => [`${n}.json`, `${n}.ready.json`]),
  outgoing: ['issue', ...seq('response')].flatMap(n => [`${n}.json`, `${n}.ready.json`]).concat(['active.lock']),
});

async function fileSha(file) {
  const h = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try { for await (const chunk of handle.createReadStream()) h.update(chunk); } finally { await handle.close(); }
  return h.digest('hex');
}

async function assertRealDir(dir) {
  const stat = await fs.lstat(dir);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'SPOOL_PARENT_NOT_A_REAL_DIRECTORY', path.basename(dir));
  check(path.resolve(await fs.realpath(dir)).toLowerCase() === path.resolve(dir).toLowerCase(), 'SPOOL_PARENT_REDIRECTED', path.basename(dir));
}

async function leafFacts(file, rel) {
  const stat = await fs.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink(), 'SPOOL_LEAF_TYPE_REFUSED', rel);
  check(stat.nlink === 1, 'SPOOL_LEAF_MULTI_LINK_REFUSED', rel);
  check(stat.size <= MAX_LEAF, 'SPOOL_LEAF_TOO_LARGE', rel);
  return { path: rel, bytes: stat.size, ino: String(stat.ino), sha256: await fileSha(file) };
}

// Read-only inventory of the allow-listed records that exist now. Half pairs are reported, not hidden.
export async function protocolLeaves(spoolRoot, layout = WINDOWS_PROTOCOL) {
  await assertRealDir(spoolRoot);
  const leaves = [];
  for (const [sub, names] of Object.entries(layout)) {
    const dir = path.join(spoolRoot, sub);
    if (!(await exists(dir))) continue;
    await assertRealDir(dir);
    for (const name of names) {
      const file = path.join(dir, name);
      if (await exists(file)) leaves.push(await leafFacts(file, `${sub}/${name}`));
    }
  }
  return leaves;
}

export function planArchive({ spoolRoot, batchKey, reason, leaves, quiescence }) {
  check(HEX64.test(batchKey), 'ARCHIVE_BATCH_KEY_INVALID');
  check(REASON.test(reason), 'ARCHIVE_REASON_INVALID');
  // Quiescence: the executor must have proved that no process of this batch can still write.
  check(quiescence && quiescence.proven === true && typeof quiescence.basis === 'string' && quiescence.basis.length > 0, 'ARCHIVE_REQUIRES_QUIESCENCE_PROOF');
  check(Array.isArray(leaves), 'ARCHIVE_INVENTORY_REQUIRED');
  const prefix = reason === 'success-close' || /^between-roles-[46]$/.test(reason) ? 'archive' : 'failed';
  const directory = `${prefix}-${batchKey.slice(0, 12)}-${reason}-${nonce()}`;
  return {
    contract: ARCHIVE_CONTRACT, spoolRoot, directory, batchKey, reason, quiescence, deletesAnything: false,
    moves: leaves.map(l => ({ from: l.path, to: `${directory}/${l.path}`, bytes: l.bytes, ino: l.ino, sha256: l.sha256 })),
  };
}

// Apply a plan: the plan file is written first (a crash mid-way leaves a record of intent), then
// each leaf is re-checked (parents, type, link count, identity, bytes), renamed and re-hashed.
// Any mismatch stops immediately; the caller must HALT; partial state is preserved as found.
export async function applyArchive(plan, clock = Date.now) {
  await assertRealDir(plan.spoolRoot);
  const target = path.join(plan.spoolRoot, plan.directory);
  check(!(await exists(target)), 'ARCHIVE_TARGET_EXISTS');
  await fs.mkdir(target);
  await writeNew(path.join(target, 'archive-plan.json'), { ...plan, plannedAt: isoNow(clock) });
  const moved = [];
  for (const move of plan.moves) {
    const sub = move.from.split('/')[0];
    await assertRealDir(path.join(plan.spoolRoot, sub));
    const from = path.join(plan.spoolRoot, move.from);
    const to = path.join(plan.spoolRoot, move.to);
    const now = await leafFacts(from, move.from);
    check(now.ino === move.ino && now.sha256 === move.sha256, 'ARCHIVE_LEAF_CHANGED_BEFORE_MOVE', move.from);
    await fs.mkdir(path.dirname(to), { recursive: true });
    check(!(await exists(to)), 'ARCHIVE_LEAF_TARGET_EXISTS', move.to);
    await fs.rename(from, to);
    const after = await leafFacts(to, move.to);
    check(after.ino === move.ino && after.sha256 === move.sha256, 'ARCHIVE_LEAF_CHANGED_AFTER_MOVE', move.to);
    moved.push(move.from);
  }
  const result = { contract: ARCHIVE_CONTRACT, directory: plan.directory, moved: moved.length, verified: true, deleted: 0, completedAt: isoNow(clock) };
  await writeNew(path.join(target, 'archive-result.json'), result);
  return result;
}
