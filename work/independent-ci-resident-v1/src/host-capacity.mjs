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

// ---- the resident's own reading (disk/memory guard, 2026-11-15) ----
// Field facts 2026-11-15: neither resident node has the governance task (no status file), so the rule above held nothing while
// TURING's C: (its resident WSL disk) fell to 5 GB. The resident therefore reads the same rule itself, shipped with its package:
// the governance status when it is fresh, else its own measurement of the drives it writes (the WSL disk's, from the install
// record, and the resident root's) at the standard's numbers (held equal to config/node-governance-standard.json disk by its
// test) and host memory at the compact capacity profile's suspend/resume numbers. Hysteresis: red below the red line, green
// again only at the recover line. Anything that cannot be read is { ok: false }: the guard then does nothing (never a hold).
export const DISK_LEVELS = Object.freeze({ redGb: 10, recoverGb: 15 });
export const MEMORY_LEVELS = Object.freeze({ redGb: 1.5, recoverGb: 2.5 });
export const NODE_RESOURCE_RED = 'NODE_RESOURCE_RED';
export const NODE_MEMORY_LOW = 'NODE_MEMORY_LOW';
// The executor's intake hold of this guard (executor.mjs#nodeResourceRefresh).
export const NODE_RESOURCE_HOLDER = 'node-resource';
const GB = 1024 ** 3;

// The drive of the resident's WSL disk from the install record (companion-wsl.json), null when it says none.
export function wslDrive(text) {
  try { const r = JSON.parse(text); return r?.contract === 'clued.independent-ci.companion-wsl/1' && /^[A-Za-z]:\\/.test(r.target ?? '') ? r.target[0].toUpperCase() : null; } catch { return null; }
}

// ports: { statusFile, installRecord (path), root (the resident root), statfs(path) -> { bavail, bsize }, freemem() -> bytes,
// readFile(path) -> string, clock }. Returns an async reader -> { ok, red, reason, source, drives: [{ drive, freeGb }], memoryFreeGb }.
export function createNodeResourceReader({ statusFile = NODE_STATUS_FILE, installRecord, root, statfs, freemem, readFile = p => fs.readFile(p, 'utf8'), clock = Date.now }) {
  let diskRed = false, memoryRed = false;
  const below = (held, free, l) => (held ? free < l.recoverGb : free < l.redGb);
  return async () => {
    try {
      const memoryFreeGb = gb(freemem() / GB);
      if (memoryFreeGb === null) return { ok: false };
      memoryRed = below(memoryRed, memoryFreeGb, MEMORY_LEVELS);
      const s = await readNodeStatus(statusFile);
      let drives, source;
      if (s.ok && Math.abs(clock() - s.writtenAtMs) <= NODE_STATUS_MAX_AGE_MS) {
        source = 'governance';
        diskRed = s.intake.level === 'red';
        drives = s.drives.filter(d => d.drive === s.intake.drive).map(d => ({ drive: d.drive, freeGb: d.freeGb }));
      } else {
        source = 'self';
        let wsl = null;
        try { wsl = wslDrive(await readFile(installRecord)); } catch { wsl = null; }
        const letters = [...new Set([wsl ?? 'C', String(root ?? 'C:')[0].toUpperCase()])].filter(l => /^[A-Z]$/.test(l));
        drives = [];
        for (const l of letters) {
          const st = await statfs(`${l}:\\`);
          const freeGb = gb((Number(st.bavail) * Number(st.bsize)) / GB);
          if (freeGb === null) return { ok: false };
          drives.push({ drive: l, freeGb });
        }
        diskRed = drives.some(d => below(diskRed, d.freeGb, DISK_LEVELS));
      }
      return { ok: true, red: diskRed || memoryRed, reason: diskRed ? NODE_RESOURCE_RED : memoryRed ? NODE_MEMORY_LOW : null, source, drives, memoryFreeGb };
    } catch {
      return { ok: false };
    }
  };
}

// -> { text } while the status names a red line; null otherwise. Never throws.
export async function readCapacityAlert(file = NODE_STATUS_FILE, clock = Date.now) {
  const s = await readNodeStatus(file);
  if (!s.ok || Math.abs(clock() - s.writtenAtMs) > NODE_STATUS_MAX_AGE_MS) return null;
  const text = capacityText(s);
  return text ? { text } : null;
}

// The PR page line while the executor's own disk/memory hold is in force (status.intakePause holder node-resource), or null.
export function resourceHoldAlert(status) {
  return (status?.intakePause?.holders ?? []).some(h => h?.holder === NODE_RESOURCE_HOLDER) ? { text: `${CAPACITY_ALERT_TEXT}（暂停接新批）` } : null;
}
