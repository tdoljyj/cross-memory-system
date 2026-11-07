// Local receipt directory for the provenance attestations (DSSE files), next to the other receipts.
//   <receipts>\provenance\<testSha>-<role>-<jobId16>.dsse.json     (Windows: STATE_V2.receipts; Linux: LINUX_PROVENANCE_DIR)
// Create-only, fsynced, mode 0600. Nothing here is ever sent to a transparency log (the repository is private); the files are
// local evidence only. state-retention.mjs ignores names it does not own, so these files are not pruned by it.
import fs from 'node:fs/promises';
import path from 'node:path';

export const PROVENANCE_DIRECTORY = 'provenance';
export const LINUX_PROVENANCE_DIR = '/var/lib/clued-independent-ci/provenance';
export const PROVENANCE_NAME = /^([a-f0-9]{40})-([a-z][a-z0-9_.-]{0,79})-([a-f0-9]{16})\.dsse\.json$/;
export const MAX_PROVENANCE_BYTES = 256 * 1024;
export const MAX_PROVENANCE_FILES = 500;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export const provenanceFileName = job => `${job.testSha}-${job.role}-${job.id.slice(0, 16)}.dsse.json`;

// Writes the DSSE envelope create-only. Returns { file, created }; an identical existing file is not an error (a re-run of the same
// job), a different one is: a job id never gets two attestations.
export async function writeProvenance({ dir, job, envelope }) {
  const bytes = Buffer.from(JSON.stringify(envelope) + '\n', 'utf8');
  if (bytes.length > MAX_PROVENANCE_BYTES) fail('provenance_too_large');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, provenanceFileName(job));
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await fs.readFile(file)).equals(bytes)) fail('provenance_exists_different');
    return { file, created: false };
  }
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return { file, created: true };
}

// The attestation files of one tested commit, by name only (no content read). Sorted; bounded.
export async function listProvenance(dir, sha) {
  let names;
  try { names = await fs.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const mine = names.filter(n => { const m = PROVENANCE_NAME.exec(n); return m && m[1] === sha; }).sort();
  if (mine.length > MAX_PROVENANCE_FILES) fail('provenance_too_many_files');
  return mine.map(n => path.join(dir, n));
}
