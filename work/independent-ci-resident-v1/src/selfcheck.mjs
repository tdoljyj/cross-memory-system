// The node proves for itself that its Linux execution side is used once and thrown away (DESIGN §70.7, Task 4a).
//
// The root tool's `selfcheck` (linux/bin/clued-ci-resident-linux) runs, between batches only, the rehearsal probe of §70.7 (the worker unit's
// own view settings handed to systemd-run, view-check inside) and counts the labelled containers (must be 0). The companion carries its
// one JSON answer into upgrade\mailbox\responses\selfcheck.json (replaced whole), the same lane that keeps the version facts, so the same
// generic package brings the check to every node after an install or an upgrade and nobody runs it by hand. The resident reads the file
// every tick (status.mjs versionsView) and shows it in status /8 `versions.selfcheck`; a failure is also a notice (`selfcheck-failed`).
// It only shows and warns: a missing, stale or failed self-check never stops admission or a merge (a helper that cannot run does nothing).
// Not imported by the upgrader (its frozen copy is src/canonical, inbox, instance-lock, intake-pause, store, upgrade-mailbox).
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX40, HEX64, canonicalJson, check, exactKeys, parseBoundedJson } from './canonical.mjs';
import { TEMP_PREFIX, exists, nonce, readBounded } from './store.mjs';

export const SELFCHECK_CONTRACT = 'clued.independent-ci.node-selfcheck/1';
export const LINUX_SELFCHECK_CONTRACT = 'clued.independent-ci.resident-linux-selfcheck/1';
export const SELFCHECK_FILE = 'selfcheck.json';
export const SELFCHECK_MAX_BYTES = 8 * 1024;
export const SELFCHECK_TIMEOUT_MS = 150_000;
// A result older than this is shown as STALE (the companion or the Linux side did not answer), never as the old verdict.
export const SELFCHECK_FRESH_MS = 30 * 60_000;
export const SELFCHECK_REFRESH_MS = 10 * 60_000;
export const SELFCHECK_BUSY_RETRY_MS = 60_000;
const ITEM = /^[A-Z][A-Z0-9_]{2,59}(?::[A-Za-z0-9/._-]{1,120})?$/;
const isIso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function packageGenerationOf(version) {
  const m = typeof version === 'string' && /^g([0-9]{6})$/.exec(version);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

export function parseInstalledPackage(v) {
  if (!plain(v)) return null;
  const packageGeneration = packageGenerationOf(v.version);
  if (packageGeneration === null || v.packageGeneration !== packageGeneration || v.releaseTag !== `fleet-node-${v.version}`
    || typeof v.commit !== 'string' || !HEX40.test(v.commit)
    || typeof v.archiveSha256 !== 'string' || !HEX64.test(v.archiveSha256)
    || typeof v.ciSourceManifestSha256 !== 'string' || !HEX64.test(v.ciSourceManifestSha256)) return null;
  return { packageGeneration, version: v.version, releaseTag: v.releaseTag, commit: v.commit,
    archiveSha256: v.archiveSha256, ciSourceManifestSha256: v.ciSourceManifestSha256 };
}

export function installedPackageView(status, identity = null, observedAt = null) {
  return { packageGeneration: null, version: null, releaseTag: null, commit: null, archiveSha256: null, ciSourceManifestSha256: null,
    ...(status === 'verified' ? identity : null), status,
    display: status === 'verified' ? `第 ${identity.packageGeneration} 代` : status === 'failed' ? '版本核验失败' : '未标注', observedAt };
}

// This verdict belongs to the live Windows/Linux comparison. The Linux-only
// selfcheck.json stays on its existing contract.
export function withPackageSelfcheck(view, installedPackage) {
  if (installedPackage.status === 'unmarked') return view;
  return { ...view, installedPackage: { status: installedPackage.status, observedAt: installedPackage.observedAt } };
}

// The tool's DONE answer, re-checked field by field (BUSY and anything else is not a result: null). Returns the document the file holds.
export function selfcheckDocument(tool, now) {
  if (!plain(tool) || tool.contract !== LINUX_SELFCHECK_CONTRACT || tool.state !== 'DONE') return null;
  try {
    const doc = { contract: SELFCHECK_CONTRACT, observedAt: new Date(now).toISOString(), at: tool.at,
      view: { ok: tool.view?.ok, code: tool.view?.code ?? null, failures: tool.view?.failures },
      containers: { count: tool.containers?.count, code: tool.containers?.code ?? null } };
    return validateSelfcheck(doc);
  } catch { return null; }
}

export function validateSelfcheck(v) {
  exactKeys(v, ['contract', 'observedAt', 'at', 'view', 'containers'], 'SELFCHECK_REFUSED');
  check(v.contract === SELFCHECK_CONTRACT && isIso(v.observedAt) && isIso(v.at), 'SELFCHECK_REFUSED', 'head');
  exactKeys(v.view, ['ok', 'code', 'failures'], 'SELFCHECK_REFUSED');
  check(typeof v.view.ok === 'boolean' && (v.view.code === null || ITEM.test(v.view.code)) && Array.isArray(v.view.failures) && v.view.failures.length <= 12
    && v.view.failures.every(f => typeof f === 'string' && ITEM.test(f)) && (v.view.ok ? v.view.code === null : v.view.code !== null), 'SELFCHECK_REFUSED', 'view');
  exactKeys(v.containers, ['count', 'code'], 'SELFCHECK_REFUSED');
  check((v.containers.count === null ? ITEM.test(v.containers.code ?? '') : Number.isSafeInteger(v.containers.count) && v.containers.count >= 0 && v.containers.code === null), 'SELFCHECK_REFUSED', 'containers');
  return v;
}

// The view the status shows: null (no file), or { observedAt, result: PASS | FAIL | STALE, viewOk, viewCode, failures, containers, containerCode }.
// PASS only when the view probe passed and no labelled container is left; a count that could not be read is FAIL (never a silent 0).
export function selfcheckView(doc, now) {
  if (!doc) return null;
  let v;
  try { v = validateSelfcheck(doc); } catch { return null; }
  const stale = now - Date.parse(v.observedAt) > SELFCHECK_FRESH_MS;
  const pass = v.view.ok && v.containers.count === 0;
  return { observedAt: new Date(Date.parse(v.observedAt)).toISOString(), result: stale ? 'STALE' : pass ? 'PASS' : 'FAIL', viewOk: v.view.ok, viewCode: v.view.code,
    failures: v.view.failures, containers: v.containers.count, containerCode: v.containers.code };
}

export async function readSelfcheck(dir) {
  const file = path.join(dir, SELFCHECK_FILE);
  try {
    if (!(await exists(file))) return null;
    return validateSelfcheck(parseBoundedJson(await readBounded(file, SELFCHECK_MAX_BYTES, 'SELFCHECK_REFUSED'), SELFCHECK_MAX_BYTES, 'SELFCHECK_REFUSED'));
  } catch { return null; }
}

// Replaced whole (temporary file + rename), as the version facts are: a reader finds the old or the new file.
export async function writeSelfcheck(dir, doc) {
  validateSelfcheck(doc);
  const tmp = path.join(dir, `${TEMP_PREFIX}${nonce()}-${SELFCHECK_FILE}`);
  try {
    const handle = await fs.open(tmp, 'wx');
    try { await handle.writeFile(canonicalJson(doc) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, path.join(dir, SELFCHECK_FILE));
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

// The view as the board keeps it and the reader returns it: every field re-checked, null for what does not fit.
export function parseSelfcheckView(v) {
  if (!plain(v) || !['PASS', 'FAIL', 'STALE'].includes(v.result) || !isIso(v.observedAt) || typeof v.viewOk !== 'boolean') return null;
  const item = x => (typeof x === 'string' && ITEM.test(x) ? x : null);
  return { observedAt: new Date(Date.parse(v.observedAt)).toISOString(), result: v.result, viewOk: v.viewOk, viewCode: item(v.viewCode),
    failures: Array.isArray(v.failures) ? v.failures.map(item).filter(Boolean).slice(0, 12) : [],
    containers: Number.isSafeInteger(v.containers) && v.containers >= 0 ? v.containers : null, containerCode: item(v.containerCode) };
}

// The one notice: the self-check ran and failed (the first code, so the key changes when the reason does). STALE and PASS are no notice.
export function selfcheckNotice(view) {
  if (!view || view.result !== 'FAIL') return null;
  const code = view.viewCode ?? view.containerCode ?? (view.containers > 0 ? 'EARLIER_CONTAINER_PRESENT' : 'SELFCHECK_FAILED');
  return { key: `selfcheck-failed:${code.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}`, kind: 'selfcheck-failed', pr: null, headSha: null, code: code.includes(':') ? code.split(':')[0] : code, at: view.observedAt, until: null };
}
