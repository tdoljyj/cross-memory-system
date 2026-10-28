// FIXTURE ONLY. Loader for trusted-workflows.json: the exact reviewed bytes of the three hosted workflows
// the local formal roles pin, on main and in the frozen PR-B commit (repin-trusted-workflows.mjs). Tests build trusted
// Sources from these bytes instead of the working tree, so they hold on a head carrying either version. Each workflow is
// stored as its lines (split on \n, joined back exactly), so the fixture's lines are the workflow's own lines.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const WORKFLOWS = JSON.parse(fs.readFileSync(new URL('./trusted-workflows.json', import.meta.url), 'utf8'));
export const VERSIONS = Object.freeze(['main', 'pr-b']);
export const GITLEAKS = '.github/workflows/gitleaks.yml';
export const TRIVY = '.github/workflows/trivy.yml';
export const PLACEMENT = '.github/workflows/contract-placement.yml';
export const GITLEAKS_SUCCESSOR = WORKFLOWS.successors?.gitleaks729 ?? null;
export function successorWorkflowBytes() {
  const entry = GITLEAKS_SUCCESSOR?.files?.[GITLEAKS];
  if (!entry || !Array.isArray(entry.lines) || !entry.lines.every(line => typeof line === 'string'))
    throw new Error('gitleaks successor workflow has not been frozen');
  return Buffer.from(entry.lines.join('\n'), 'utf8');
}

export function workflowBytes(version, file) {
  const entry = WORKFLOWS.versions?.[version]?.files?.[file];
  if (!entry || !Array.isArray(entry.lines) || !entry.lines.every(line => typeof line === 'string'))
    throw new Error(`no trusted workflow fixture for ${version} ${file}`);
  return Buffer.from(entry.lines.join('\n'), 'utf8');
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const gitBlob = bytes => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
export const workflowSha256 = (version, file) => sha256(workflowBytes(version, file));
// The accepted set every role must carry for `file`, in fixture order (main first, then PR-B).
export const acceptedSha256s = file => VERSIONS.map(version => workflowSha256(version, file));
