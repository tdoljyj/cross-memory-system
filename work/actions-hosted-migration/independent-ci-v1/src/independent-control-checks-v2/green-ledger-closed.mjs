// Green ledger cleanup (step 3c-2b; DESIGN §41.3 "台账清理", §19.7 N2). A group of records (one effect key) whose last
// phase is a twice-confirmed `revoked` (stage 10 writes its detail as REVOKED_TWICE_PREFIX...), or `merged` with the
// head in main, older than 14 days, moves whole to green-ledger\closed\<yyyy-mm>\ (same ACL by inheritance).
// GreenLedger#list reads the top level only. The ledger is one source among several: a wrong close is caught by the
// publication stream and the GitHub enumeration of the sweeps. Each file moves by link + unlink (never replaced).
import fs from 'node:fs/promises';
import path from 'node:path';

export const CLOSE_AFTER_MS = 14 * 86_400_000;
export const CLOSED_DIRECTORY = 'closed';
// The detail of a stage-10 revocation confirmed by both read-backs: `revoked2:<first read-back>,<second read-back>;<reason>`.
export const REVOKED_TWICE_PREFIX = 'revoked2:';
const MONTH = /^\d{4}-\d\d/;

// inMain: head -> true | false | null (null: could not be read; the group stays). At most maxGroups per call, and none
// started after `deadline` (clock(); stage 10's cap, review R2 minor 5).
export async function closeGreenLedgerGroups({ ledger, inMain, now, ageMs = CLOSE_AFTER_MS, maxGroups = 50, deadline = Infinity, clock = Date.now }) {
  const { entries } = await ledger.list();
  const groups = new Map();
  for (const e of entries) { const g = groups.get(e.entry.effectKey) ?? []; g.push(e); groups.set(e.entry.effectKey, g); }
  let closed = 0, files = 0;
  for (const group of groups.values()) {
    if (closed >= maxGroups || clock() > deadline) break;
    const last = group[group.length - 1].entry;
    if (!(now - Date.parse(last.at) > ageMs)) continue;
    const done = (last.phase === 'revoked' && typeof last.detail === 'string' && last.detail.startsWith(REVOKED_TWICE_PREFIX))
      || (last.phase === 'merged' && await inMain(last.headSha) === true);
    if (!done) continue;
    const target = path.join(ledger.directory, CLOSED_DIRECTORY, MONTH.exec(last.at)[0]);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const { name } of group) {
      const from = path.join(ledger.directory, name), to = path.join(target, name);
      try { await fs.link(from, to); } catch (e) {
        // a crash between link and unlink left the copy: only the same bytes may stand for it
        if (e?.code !== 'EEXIST' || !(await fs.readFile(from)).equals(await fs.readFile(to))) throw e;
      }
      await fs.unlink(from);
      files++;
    }
    closed++;
  }
  return { closed, files };
}
