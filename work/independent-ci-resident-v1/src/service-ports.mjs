// Real ports for the CluedCIResident service: the companion over the mailbox, and installed-Source
// integrity. Both are deliberately thin; all decisions stay in executor.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX64, check, exactKeys, parseBoundedJson, sha256 } from './canonical.mjs';

// Timeouts are upper bounds for one companion action; no answer by then is never success.
const TIMEOUTS = { 'build-bundle': 35 * 60_000, 'prepare-workspaces': 25 * 60_000, 'archive-linux': 6 * 60_000, 'linux-quiescence': 2 * 60_000, 'check-refs': 6 * 60_000, 'archive-usage': 3 * 60_000,
  'pr-head': 2 * 60_000 };
const NO_BATCH = '0000000000000000-000000000000';

export function mailboxCompanion(mailbox, sleep) {
  const ask = async (kind, fields) => mailbox.await(await mailbox.send(kind, fields, TIMEOUTS[kind]), sleep);
  return {
    heartbeat: () => mailbox.heartbeat(),
    // The newest companion hint for this head (bytes; the executor parses), or null. Never authority.
    async hostedHint(subject) { try { return await mailbox.latestHint(subject.pr, subject.headSha); } catch { return null; } },
    // jobTree (DESIGN §24): what the companion's job host found about the bundle's child (mailbox.mjs RESPONSE_CONTRACT); null
    // also when no answer came. Recorded with a stage-0 failure; the release never waits for it.
    async buildBundle(batch) {
      const r = await ask('build-bundle', { batchId: batch.batchId });
      return { ok: r?.ok === true, code: r?.code ?? 'BUNDLE_UNAVAILABLE', jobTree: r?.jobTree ?? null };
    },
    async prepareWorkspaces(batch) {
      const r = await ask('prepare-workspaces', { batchId: batch.batchId });
      return r ? { ok: r.ok, code: r.code, proof: r.proof ?? {} } : { ok: false, code: 'WORKSPACE_PREPARATION_UNCONFIRMED', proof: {} };
    },
    // No answer, or anything but the root tool's own true/true, is "not quiescent".
    async linuxQuiescence(batch) {
      const id = batch?.batchId ?? '0000000000000000-000000000000';
      const r = await ask('linux-quiescence', { batchId: id });
      return { linuxUnitsInactive: r?.ok === true && r.proof?.linuxUnitsInactive === true, containersZero: r?.ok === true && r.proof?.containersZero === true };
    },
    // Source v2: refs still the bundle's (stage 2 gate) and the Linux archive size (retention).
    async checkRefs(batch) {
      const r = await ask('check-refs', { batchId: batch.batchId });
      return { ok: r?.ok === true, code: r?.ok === true ? null : (r?.code ?? 'REMOTE_REFS_UNAVAILABLE') };
    },
    async archiveUsage() {
      const r = await ask('archive-usage', { batchId: NO_BATCH });
      return r?.ok === true && r.usage ? { ok: true, ...r.usage } : { ok: false };
    },
    // Phase 2, step 1: one live read of the PR (state, head) for the run queue, or null (no answer is never a fact).
    async prHead(pr, batch = null) {
      const r = await ask('pr-head', { batchId: batch?.batchId ?? NO_BATCH, pr });
      return r?.ok === true && r.pull ? r.pull : null;
    },
    async archiveLinux(batch, reason) {
      const r = await ask('archive-linux', { batchId: batch.batchId, reason });
      return { verified: r?.ok === true && r.verified === true, directory: r?.directory ?? null };
    },
  };
}

// Installed manifests list every file of the installed CI Source and of the resident layer with its
// SHA-256 and size. The service re-hashes all of them before every batch (RESIDENT_SOURCE_DRIFT).
export const INSTALLED_MANIFEST_CONTRACT = 'clued.independent-ci.resident-installed-manifest/1';

async function verifyManifest(root, manifestFile) {
  const bytes = await fs.readFile(manifestFile);
  const m = parseBoundedJson(bytes, 4 * 1024 * 1024, 'INSTALLED_MANIFEST_REFUSED');
  exactKeys(m, ['contract', 'root', 'files'], 'INSTALLED_MANIFEST_REFUSED');
  check(m.contract === INSTALLED_MANIFEST_CONTRACT && Array.isArray(m.files) && m.files.length > 0, 'INSTALLED_MANIFEST_REFUSED');
  for (const f of m.files) {
    exactKeys(f, ['path', 'sha256', 'bytes'], 'INSTALLED_MANIFEST_ENTRY_REFUSED');
    check(typeof f.path === 'string' && !f.path.includes('..') && !path.isAbsolute(f.path) && HEX64.test(f.sha256), 'INSTALLED_MANIFEST_ENTRY_REFUSED');
    const file = path.join(root, f.path);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size !== f.bytes) return { ok: false };
    if (sha256(await fs.readFile(file)) !== f.sha256) return { ok: false };
  }
  return { ok: true, sha256: sha256(bytes) };
}

export function installedIntegrity({ sourceRoot, sourceManifest, residentRoot, residentManifest }) {
  return async () => {
    try {
      const s = await verifyManifest(sourceRoot, sourceManifest);
      const r = await verifyManifest(residentRoot, residentManifest);
      return { ok: s.ok && r.ok, sourceManifestSha256: s.sha256 ?? null, residentManifestSha256: r.sha256 ?? null };
    } catch {
      return { ok: false };
    }
  };
}
