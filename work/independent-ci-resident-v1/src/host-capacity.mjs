// The node's resource status (Node Resource Governance v1): the node's one governance task (Clued-Node-Governance,
// scripts/ci/self-hosted/node-governance/render.ps1) judges every declared drive green / yellow / red and writes the one status
// file every reader takes: C:\ProgramData\Clued\node-governance\status.json, contract clued.node-governance-status/1:
//   { contract, host, writtenAt, dryRun, level, intake: { drive, level }, drives: [{ drive, freeGb, totalGb, level }],
//     linuxRunners: null | { suspended, since, detail }, ... }
// intake is the drive of the resident CI's WSL disk; red there holds new batches (executor.mjs nodeResourceGate). The PR page
// shows one fixed line over its numbers, never its free text (pr-status.mjs withCapacityLine). Reads are bounded, read only, a
// regular file only; anything missing, too big, torn or of another shape is { ok: false } (the readers decide what that means).
import fs from 'node:fs/promises';
import { parseBoundedJson } from './canonical.mjs';

export const NODE_STATUS_FILE = 'C:\\ProgramData\\Clued\\node-governance\\status.json';
export const NODE_STATUS_CONTRACT = 'clued.node-governance-status/1';
export const NODE_STATUS_MAX_BYTES = 65536;
// The standard's status_max_age_seconds: an older status is no status.
export const NODE_STATUS_MAX_AGE_MS = 600_000;
export const CAPACITY_ALERT_TEXT = '节点资源红线';

const LEVELS = ['green', 'yellow', 'red'];
const drive = d => d && typeof d === 'object' && /^[A-Z]$/.test(d.drive ?? '') && LEVELS.includes(d.level);
const gb = n => (Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null);

export async function readNodeStatus(file = NODE_STATUS_FILE) {
  let fh = null;
  try {
    fh = await fs.open(file, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size <= 0 || st.size > NODE_STATUS_MAX_BYTES) return { ok: false };
    const buf = Buffer.alloc(NODE_STATUS_MAX_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const s = parseBoundedJson(buf.subarray(0, bytesRead), NODE_STATUS_MAX_BYTES, 'NODE_STATUS_REFUSED');
    const at = Date.parse(s?.writtenAt);
    if (s?.contract !== NODE_STATUS_CONTRACT || typeof s.host !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(s.host) || !Number.isFinite(at)
      || !LEVELS.includes(s.level) || !drive(s.intake) || !Array.isArray(s.drives) || !s.drives.every(drive)) return { ok: false };
    const linuxRunners = s.linuxRunners && typeof s.linuxRunners === 'object' ? { suspended: s.linuxRunners.suspended === true } : null;
    return { ok: true, host: s.host, writtenAtMs: at, level: s.level, intake: { drive: s.intake.drive, level: s.intake.level },
      drives: s.drives.map(d => ({ drive: d.drive, level: d.level, freeGb: gb(d.freeGb) })), linuxRunners };
  } catch {
    return { ok: false };
  } finally {
    await fh?.close().catch(() => {});
  }
}

// The PR page line, or null: red on the resident's drive (new batches held) or the Linux runners held back.
export function capacityText(s) {
  if (!s?.ok) return null;
  if (s.intake?.level === 'red') {
    const free = s.drives?.find(d => d.drive === s.intake.drive)?.freeGb;
    return `${CAPACITY_ALERT_TEXT}（${s.host} ${s.intake.drive}:${free === null || free === undefined ? '' : ` 剩 ${free} GB`}，暂停接新批）`;
  }
  return s.linuxRunners?.suspended ? `${CAPACITY_ALERT_TEXT}（${s.host} Linux runner 已停）` : null;
}

// -> { text } while the status names a red line; null otherwise. Never throws.
export async function readCapacityAlert(file = NODE_STATUS_FILE, clock = Date.now) {
  const s = await readNodeStatus(file);
  if (!s.ok || Math.abs(clock() - s.writtenAtMs) > NODE_STATUS_MAX_AGE_MS) return null;
  const text = capacityText(s);
  return text ? { text } : null;
}
