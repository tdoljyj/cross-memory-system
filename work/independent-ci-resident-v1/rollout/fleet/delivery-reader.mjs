// Candidate capabilities come from the exact archive already verified by seal.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deliveryBound } from './delivery-preflight.mjs';
import { readArchive } from './install.mjs';

// Source assembly imports code. Compare the archive's tree to the checked
// commit before allowing the publisher or the release job to assemble it.
export function verifyDeliveryTree(archive, request, cwd) {
  const { entries } = readArchive(archive, request.archive_sha256, request);
  const tree = execFileSync('git', ['ls-tree', '-r', '-z', request.commit],
    { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const blobs = new Map();
  for (const row of tree.split('\0')) {
    const match = /^100(?:644|755) blob ([0-9a-f]{40})\t(.+)$/s.exec(row);
    if (match) blobs.set(match[2], match[1]);
  }
  for (const entry of entries.filter(entry => entry.path.startsWith('tree/'))) {
    const blob = createHash('sha1').update(`blob ${entry.data.length}\0`).update(entry.data).digest('hex');
    if (blobs.get(entry.path.slice(5)) !== blob) throw new Error('FLEET_DELIVERY_RELEASE_TREE_CHANGED');
  }
}
// Each invocation is confined to one pair of independently read snapshots.
// No network answer is shared across open and attach, or across candidates.
export function deliveryProjectionReaders({ read }) {
  let pair;
  let reads = 0;
  return {
    async readFleetRegistry(candidate, options) {
      pair ??= await read(candidate, options);
      const view = reads++ === 0 ? pair?.first : pair?.last;
      return deliveryBound(view?.candidate, candidate) ? view : null;
    },
  };
}
