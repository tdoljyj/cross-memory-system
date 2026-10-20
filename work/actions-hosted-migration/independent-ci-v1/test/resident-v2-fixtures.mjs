// Shared fixtures for the Source v2 tests. Every hash, id and reference is generated at run time;
// nothing here is a host value.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { canonical } from '../src/proof.mjs';
import { assembleRecord, RECORD_INPUTS_CONTRACT } from '../src/resident-v2/prepare-record.mjs';
import { ENTRY_V2 } from '../src/resident-v2/layout.mjs';
import { RESULT_CONTRACT_V2, ENVELOPE_CONTRACT_V2 } from '../src/proof-v2.mjs';
import { subjectOfV2 } from '../src/job-v2.mjs';

export const hex = n => randomBytes(n).toString('hex');
export const sha = s => createHash('sha256').update(s).digest('hex');
export const HEAD = 'a'.repeat(40);
export const BASE = 'b'.repeat(40);
export const NOW = Date.parse('2026-10-21T08:00:00.000Z');
export const iso = ms => new Date(ms).toISOString();

export async function tempDir(t, prefix = 'clued-v2-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

export const SOURCE_PATHS = Object.freeze(['scripts/ci/clued-work-admission.mjs', 'config/merge-admission-policy.json', ...Object.values(ENTRY_V2),
  'work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs', 'work/actions-hosted-migration/independent-ci-v1/src/proof-v2.mjs',
  'work/actions-hosted-migration/independent-ci-v1/src/full-admission-v2.mjs', 'work/actions-hosted-migration/independent-ci-v1/src/batch-claim-v2.mjs',
  'work/actions-hosted-migration/independent-ci-v1/src/resident-v2/layout.mjs', '.gitleaks.toml']);

export function roles() {
  const tool = () => ({ path: '/usr/bin/fixture', sha256: hex(32) });
  return {
    gitleaks: { containerCommand: { image: `ghcr.io/gitleaks/gitleaks:v8@sha256:${hex(32)}`, scanner: 'gitleaks', executable: '/usr/bin/gitleaks', args: ['git', '/repo'], cwd: '/input' },
      hostTools: { python: tool() }, timeoutMs: 1200000, maxOutputBytes: 16777216 },
    trivy: { containerCommand: { image: `ghcr.io/aquasecurity/trivy:0.74.0@sha256:${hex(32)}`, scanner: 'trivy', executable: '/usr/local/bin/trivy', args: ['fs'], cwd: '/input' },
      formalTrivy: { profile: 'required-trivy-three-scanners/1', cacheRoot: '/var/lib/fixture-cache', checksPin: { repository: 'ghcr.io/aquasecurity/trivy-checks:2', majorVersion: 2, digest: `sha256:${hex(32)}`, contentSha256: hex(32) } },
      timeoutMs: 1500000, maxOutputBytes: 16777216 },
    'contract-placement': { command: { executable: '/usr/bin/fixture-node', executableSha256: hex(32), args: ['/control/contract-placement-entry.mjs'], cwd: '.' },
      formalContractPlacement: { profile: 'required-contract-placement/1', workflowSha256: hex(32), esbuildVersion: '0.28.1', tools: { node: tool(), python: tool(), git: tool(), esbuildJs: tool(), esbuildBinary: tool() } },
      timeoutMs: 300000, maxOutputBytes: 16777216 },
  };
}

export function signerKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKey };
}

export function recordInputs(overrides = {}, refs = null, signer = signerKeys()) {
  const references = refs ?? Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef', 'ownerPackageAcceptanceRef', 'installationReceiptRef'].map(k => [k, randomUUID()]));
  return { contract: RECORD_INPUTS_CONTRACT, repository: 'tdoljyj/cross-memory-system', sourceCommit: 'c'.repeat(40), scope: `project:${randomUUID()}`, hostname: 'TURING',
    controllerAccount: 'clued-control', appId: 5368905, installationId: 172706661, repositoryId: 1334673495, appKeyId: 4918220,
    ciPrincipalBindingId: randomUUID(), ciPrincipalRoleRef: randomUUID(), ciTokenPinSha256: hex(32), appPublicKeySha256Base64: Buffer.from(randomBytes(32)).toString('base64'),
    supabaseUrl: 'https://fixtureproject.supabase.co', publishableKey: 'sb_publishable_fixture', controllerNodeSha256: hex(32), references,
    owner: { ownerDecisionRef: randomUUID(), ownerReceiptRef: randomUUID(), acceptedAt: '2026-01-01T00:00:00.000Z', validUntil: null },
    formalRoles: roles(),
    signers: { signers: [{ domain: 'production', keyId: 'fixture-key', publicKeyPem: signer.publicKeyPem, runtimeId: 'fixture-runtime', qualificationRef: references.hostQualificationRef, sourceAcceptanceRef: references.sourceAcceptanceRef }] },
    ...overrides };
}

export function sourceFiles(paths = SOURCE_PATHS) { return [...paths].sort().map(p => ({ path: p, sha256: hex(32), bytes: 10 })); }

export function fixtureRecord(overrides = {}) {
  const signer = signerKeys();
  const inputs = recordInputs(overrides, null, signer);
  const { files, recordManifest } = assembleRecord(inputs, sourceFiles());
  return { inputs, files, recordManifest, signer, docs: Object.fromEntries(Object.entries(files).map(([n, t]) => [n, Buffer.from(t)])) };
}

export async function writeRecordDir(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  for (const [n, t] of Object.entries(files)) await fs.writeFile(path.join(dir, n), t);
  return dir;
}

export function subject(o = {}) {
  return { repo: 'tdoljyj/cross-memory-system', pr: 888, headSha: HEAD, baseSha: BASE, sourceManifestSha256: 'e'.repeat(64), attempt: 1, createdAt: iso(NOW - 60_000), ...o };
}

export function signResult(job, signer, { conclusion = 'success', finishedAt = NOW - 1000, startedAt = NOW - 5000, domain = 'production' } = {}) {
  const payload = { contract: RESULT_CONTRACT_V2, domain, runtimeId: 'fixture-runtime', subject: subjectOfV2(job), startedAt: iso(startedAt), finishedAt: iso(finishedAt),
    conclusion, exitCode: conclusion === 'success' ? 0 : 1, stdoutSha256: hex(32), stderrSha256: hex(32), artifactsSha256: hex(32) };
  const signature = sign(null, Buffer.from(canonical(payload)), signer.privateKey).toString('base64url');
  return { contract: ENVELOPE_CONTRACT_V2, keyId: 'fixture-key', signature, payload };
}
