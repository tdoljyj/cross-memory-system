// The way back from receipt segmentation (step 3c-2b, DESIGN §41.7, §41.10 item 7; review R3 M7): before a previous package
// (one from before segmentation, whose ReceiptChain reads receipts\ flat from the genesis and refuses any other name) is
// installed again, the Owner runs this once with the service stopped:
//   node receipts-unseal.mjs <receipts directory> <keep directory>
// It first verifies the whole segmented chain (receipts.mjs#verifyAll: the seals, every archived month, the open segment), then
// renames every archived receipt back into receipts\ under its own name (never over a file; nothing is copied, rewritten or
// deleted), moves index\ and the emptied archive\ into <keep directory> (which must not exist yet: the seals stay as evidence),
// and verifies the flat chain from the genesis exactly as the previous reader does. Exit 0 only then. A run that stopped half way
// is finished by running it again (the seals are still in index\ until every receipt is back).
//
// Why a tool and not a stateCompat bump: the upgrader checks both directions (plan.mjs: the target reads today's state AND
// today's code reads the target's), so a new schema would refuse this very upgrade as well, and the reinstall path (§40) does
// not compare state compatibility at all. Segmentation is rename-only, so its exact reverse is renames too. Sealing again later
// (the next start of a segmenting package) is harmless: the months are sealed afresh from the genesis.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARCHIVE_DIR, INDEX_DIR, ReceiptChain } from '../src/receipts.mjs';
import { check } from '../src/canonical.mjs';
import { exists } from '../src/store.mjs';

const NAME = /^(\d{8})-([a-z0-9-]{1,48})\.json$/;

export async function unsealReceipts(dir, keep, { clock = Date.now } = {}) {
  check(typeof dir === 'string' && path.isAbsolute(dir) && typeof keep === 'string' && path.isAbsolute(keep), 'UNSEAL_ARGUMENTS_REQUIRED');
  check(path.resolve(keep) !== path.resolve(dir) && !path.resolve(keep).startsWith(`${path.resolve(dir)}${path.sep}`), 'UNSEAL_KEEP_INSIDE_RECEIPTS');
  check(!(await exists(keep)), 'UNSEAL_KEEP_EXISTS');
  const chain = new ReceiptChain(dir, clock);
  const head = await chain.verifyAll();
  const seals = await chain.seals();
  let moved = 0;
  for (const s of seals) {
    const from = path.join(dir, ARCHIVE_DIR, s.segment);
    let names = [];
    try { names = (await fs.readdir(from)).filter(n => NAME.test(n)).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) {
      check(!(await exists(path.join(dir, name))), 'UNSEAL_TARGET_EXISTS', name);
      await fs.rename(path.join(from, name), path.join(dir, name));
      moved += 1;
    }
  }
  await fs.mkdir(keep, { recursive: false });
  for (const sub of [INDEX_DIR, ARCHIVE_DIR]) if (await exists(path.join(dir, sub))) await fs.rename(path.join(dir, sub), path.join(keep, sub));
  // The previous reader: every visible name is a receipt, numbered from 1 without a gap, chained from the genesis.
  const left = (await fs.readdir(dir)).filter(n => !n.startsWith('.')).sort();
  for (const n of left) check(NAME.test(n), 'UNSEAL_FOREIGN_NAME', n);
  const flat = await new ReceiptChain(dir, clock).verify();
  check(flat.seq === head.seq && flat.sha256 === head.sha256 && left.length === head.seq, 'UNSEAL_CHAIN_CHANGED');
  return { status: 'RECEIPTS_UNSEALED', seq: flat.seq, sha256: flat.sha256, moved, seals: seals.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await unsealReceipts(process.argv[2], process.argv[3])));
  } catch (error) {
    console.log(JSON.stringify({ status: 'REFUSED', code: error.code ?? 'UNREADABLE' }));
    process.exitCode = 1;
  }
}
