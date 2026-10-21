// Source v2 Linux role policy and runtime qualification (DESIGN S6, S10). Port of qualification.mjs:
//   - claim decoupling A-strict: a policy carries NO currentClaim (a policy that has one is refused) and
//     no claim deadline bounds the qualification; the live claim reaches the Linux side only inside the
//     complete Native admission facts relayed by the Windows issuer (bridge v4);
//   - S10: the Node runtime that loads the policy must be the pinned toolchain Node, the same path the
//     systemd worker unit and the relay use (/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node);
//   - the signed qualification is schema v2: it pins this file, worker-v2.mjs, proof.mjs and job-v2.mjs
//     (no queue.mjs, no generic launcher), and `expiresAt` may be null = valid until the Source changes
//     (every pinned byte and the Source manifest hash are bound; Owner decision 1b5d3687);
//   - no default policy file: callers name one of the fixed role-v3 policies.
// Everything else (protected path rules, Docker socket and pin checks, isolation flags) is unchanged.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalJson, sha256 } from '../src/worker-v2.mjs';

export const LINUX_NODE_V2 = '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node';
export const POLICY_SCHEMA_V3 = 'independent-ci.linux-policy.v3';
export const QUALIFICATION_SCHEMA_V2 = 'independent-ci.runtime-qualification.v2';
export function requireCondition(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
const fixedPath = v => typeof v === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(v) && !v.split('/').includes('..');

export function validatePolicyShape(config) {
  requireCondition(config?.schema === POLICY_SCHEMA_V3 && config.formalEnabled === true, 'FORMAL_DISABLED');
  requireCondition(!Object.hasOwn(config, 'currentClaim') && !Object.hasOwn(config, 'claimId'), 'CLAIM_BOUND_POLICY_REFUSED');
  requireCondition(config.dockerExecutable === '/usr/bin/docker' && config.dockerEndpoint === 'unix:///run/docker.sock'
    && /^(?:sha256:[a-f0-9]{64}|[^\s,@]+@sha256:[a-f0-9]{64})$/.test(config.image), 'NATIVE_DOCKER_PIN_REQUIRED');
  requireCondition(config.containerUser === '65532:65532' && Number.isInteger(config.memoryBytes) && config.memoryBytes >= 134217728
    && config.memoryBytes <= 4294967296 && Number.isFinite(config.cpus) && config.cpus > 0 && config.cpus <= 2
    && Number.isInteger(config.pids) && config.pids >= 16 && config.pids <= 256, 'RESOURCE_POLICY_REQUIRED');
  requireCondition(['scanner', 'node-entry'].includes(config.executionMode), 'EXECUTION_MODE_REQUIRED');
  if (config.executionMode === 'node-entry') requireCondition(fixedPath(config.containerNodeExecutable) && /^[a-f0-9]{64}$/.test(config.containerNodeSha256 ?? ''), 'IMAGE_NODE_RUNTIME_UNQUALIFIED');
  for (const name of ['runtimeIdentity', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef'])
    requireCondition(typeof config[name] === 'string' && config[name].length > 0 && config[name].length <= 1000 && !/[\x00-\x1f]/.test(config[name]), 'ACCEPTED_CONTEXT_MISSING');
  for (const name of ['nodeExecutable', 'gitExecutable', 'entryFile', 'sourceManifestFile', 'publicKeyFile', 'qualificationFile', 'signingKeyFile', 'workspaceRoot', 'runsRoot', 'trustedSourceDirectory'])
    requireCondition(fixedPath(config[name]), 'FIXED_PATH_REQUIRED');
  // S10: one Node for the worker unit, the relay and the self-test; never the runner's externals node.
  requireCondition(config.nodeExecutable === LINUX_NODE_V2, 'PINNED_TOOLCHAIN_NODE_REQUIRED');
  const roots = ['workspaceRoot', 'runsRoot', 'trustedSourceDirectory'].map(k => config[k]);
  requireCondition(new Set(roots).size === roots.length && roots.every((r, i) => roots.every((other, j) => i === j || !r.startsWith(other + '/'))), 'CONTROL_DIRECTORY_OVERLAP');
  requireCondition(!roots.some(root => [config.signingKeyFile, config.qualificationFile, config.publicKeyFile].some(f => f === root || f.startsWith(root + '/'))), 'SIGNER_MOUNT_OVERLAP');
}

// Pure check of the signed qualification payload against the policy (no I/O).
export function validateQualificationPayload(q, config, publicKey, now = Date.now()) {
  requireCondition(q?.schema === QUALIFICATION_SCHEMA_V2 && q.fixture === false && q.runtimeIdentity === config.runtimeIdentity
    && q.sourceManifestSha256 === config.sourceManifestSha256 && q.image === config.image && q.entrySha256 === config.entrySha256
    && q.qualificationSha256 === config.qualificationSha256 && q.executionMode === config.executionMode && q.workerSha256 === config.workerSha256
    && q.proofSha256 === config.proofSha256 && q.jobSha256 === config.jobSha256 && q.nodeExecutable === config.nodeExecutable
    && (config.executionMode === 'scanner' || q.containerNodeExecutable === config.containerNodeExecutable && q.containerNodeSha256 === config.containerNodeSha256)
    && q.keyId === config.keyId && q.resultPublicKeySha256 === sha256(publicKey) && !Object.hasOwn(q, 'currentClaim'), 'QUALIFICATION_BINDING_REFUSED');
  requireCondition(q.isolation === 'root-managed-single-job-container' && q.prCannotReadSignerKey === true && q.noControllerMounts === true && q.noCredentials === true && q.networkDisabled === true && q.cleanupQualified === true, 'ISOLATION_UNQUALIFIED');
  requireCondition(q.hostAcceptanceRef === config.hostAcceptanceRef && q.sourceAcceptanceRef === config.sourceAcceptanceRef && typeof q.hostAcceptanceRef === 'string' && q.hostAcceptanceRef.length > 10 && typeof q.sourceAcceptanceRef === 'string' && q.sourceAcceptanceRef.length > 10, 'OWNER_ACCEPTANCE_MISSING');
  requireCondition(Date.parse(q.qualifiedAt) <= now && (q.expiresAt === null || Date.parse(q.expiresAt) > now), 'QUALIFICATION_EXPIRED');
  return q;
}
// The latest instant the qualification still covers (Infinity when it is bound to the Source only).
export const qualificationDeadline = q => q.expiresAt === null ? Infinity : Date.parse(q.expiresAt);

export async function protectedPath(filename, { directory = false, privateFile = false } = {}) {
  requireCondition(process.platform === 'linux' && process.getuid?.() === 0 && path.isAbsolute(filename), 'ROOT_LINUX_REQUIRED');
  let current = '/';
  for (const part of filename.split('/').filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    requireCondition(!stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022), 'UNPROTECTED_PATH');
  }
  const stat = await lstat(filename);
  requireCondition(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, 'UNSAFE_FILE_TYPE');
  if (privateFile) requireCondition(!(stat.mode & 0o077), 'PRIVATE_FILE_PERMISSIONS');
  requireCondition(await realpath(filename) === filename, 'PATH_ALIAS');
  return stat;
}

export async function loadQualifiedPolicyV2(configPath) {
  requireCondition(typeof configPath === 'string' && /^\/etc\/clued-independent-ci\/roles-v3\/(gitleaks|trivy|contract-placement)\.json$/.test(configPath), 'FIXED_ROLE_POLICY_V3_REQUIRED');
  await protectedPath(configPath, { privateFile: true });
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  validatePolicyShape(config);
  await protectedPath('/run', { directory: true });
  const socket = await lstat('/run/docker.sock');
  requireCondition(socket.isSocket() && !socket.isSymbolicLink() && socket.uid === 0 && !(socket.mode & 0o007), 'NATIVE_SOCKET_UNQUALIFIED');
  for (const key of ['dockerExecutable', 'nodeExecutable', 'gitExecutable', 'entryFile', 'sourceManifestFile', 'publicKeyFile', 'qualificationFile']) await protectedPath(config[key]);
  for (const key of ['workspaceRoot', 'runsRoot', 'trustedSourceDirectory']) await protectedPath(config[key], { directory: true });
  for (const [filename, pin] of [[config.entryFile, config.entrySha256], [config.dockerExecutable, config.dockerExecutableSha256],
    [config.nodeExecutable, config.nodeExecutableSha256], [config.gitExecutable, config.gitExecutableSha256],
    [fileURLToPath(import.meta.url), config.qualificationSha256],
    [fileURLToPath(new URL('../src/worker-v2.mjs', import.meta.url)), config.workerSha256],
    [fileURLToPath(new URL('../src/proof.mjs', import.meta.url)), config.proofSha256],
    [fileURLToPath(new URL('../src/job-v2.mjs', import.meta.url)), config.jobSha256]]) {
    await protectedPath(filename);
    requireCondition(/^[a-f0-9]{64}$/.test(pin ?? '') && sha256(await readFile(filename)) === pin, 'RUNTIME_SOURCE_DRIFT');
  }
  requireCondition(process.execPath === config.nodeExecutable, 'UNPINNED_NODE_RUNTIME');
  const sourceManifestBytes = await readFile(config.sourceManifestFile);
  requireCondition(sha256(sourceManifestBytes) === config.sourceManifestSha256, 'MANIFEST_HASH_MISMATCH');
  const qualification = JSON.parse(await readFile(config.qualificationFile, 'utf8'));
  const publicKey = await readFile(config.publicKeyFile);
  requireCondition(qualification && Object.keys(qualification).length === 2 && verify(null, Buffer.from(canonicalJson(qualification.payload)), publicKey, Buffer.from(qualification.signature, 'base64')), 'QUALIFICATION_SIGNATURE_REFUSED');
  validateQualificationPayload(qualification.payload, config, publicKey);
  return { config, sourceManifestBytes, qualification, publicKey };
}
