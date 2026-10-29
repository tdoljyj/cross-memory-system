// upgrade\status.json (spec A5): the upgrader's view for the Owner, the companion and the resident's status /7. A view, never
// evidence (the ops journal is): replaced whole (temporary file + rename) on every pass.
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, check, isoNow } from '../../src/canonical.mjs';
import { TEMP_PREFIX, nonce } from '../../src/store.mjs';
import { UPGRADE_OP_STATES, UPGRADE_STATUS_CONTRACT } from '../../src/upgrade-mailbox.mjs';

export const RECENT_MAX = 10;

export function buildStatus({ clock, pid, current, op = null, recent = [], generations = [] }) {
  if (op) check(UPGRADE_OP_STATES.includes(op.state), 'UPGRADE_STATUS_STATE_INVALID', op.state);
  return {
    contract: UPGRADE_STATUS_CONTRACT, writtenAt: isoNow(clock), upgraderPid: pid,
    current: current ? { generation: current.generation, packageManifestSha256: current.packageManifestSha256 } : null,
    op,
    recent: recent.slice(-RECENT_MAX),
    generations,
  };
}

export async function writeStatus(file, status) {
  const tmp = path.join(path.dirname(file), `${TEMP_PREFIX}${nonce()}-${path.basename(file)}`);
  try {
    await fs.writeFile(tmp, canonicalJson(status) + '\n', { flag: 'wx' });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}
