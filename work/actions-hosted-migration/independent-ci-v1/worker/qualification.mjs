import { lstat, readFile, realpath } from 'node:fs/promises';
import { verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalJson, sha256 } from '../src/worker.mjs';

export function requireCondition(value, code) { if (!value) throw new Error(code); }
export const requiredInstallInputs = Object.freeze([
  'Protected Linux Node/Git/native Docker executable paths and SHA-256 pins',
  'An already-local immutable image ID or repository digest; no pull fallback',
  'A fixed image-native gitleaks/trivy Source command; Node inside the image is needed only for node-entry mode',
  'Accepted Source manifest and independent root-owned exact head/base/source checkouts',
  'An externally accepted signed Host/Source qualification; this CLI cannot issue it',
  'A protected Ed25519 result key, externally pinned public key and registry key ID',
  'A fresh protected current claim/fence/epoch and a fixed request.json containing the queue job and prepared worker request',
  'Prove existing Docker administrators cannot execute untrusted PR code while the signer is present',
]);
export function validatePolicyShape(config) {
  requireCondition(config?.schema === 'independent-ci.linux-policy.v1' && config.formalEnabled === true, 'FORMAL_DISABLED');
  requireCondition(config.dockerExecutable === '/usr/bin/docker' && config.dockerEndpoint === 'unix:///run/docker.sock'
    && /^(?:sha256:[a-f0-9]{64}|[^\s,@]+@sha256:[a-f0-9]{64})$/.test(config.image), 'NATIVE_DOCKER_PIN_REQUIRED');
  requireCondition(config.containerUser === '65532:65532' && Number.isInteger(config.memoryBytes) && config.memoryBytes >= 134217728
    && config.memoryBytes <= 4294967296 && Number.isFinite(config.cpus) && config.cpus > 0 && config.cpus <= 2
    && Number.isInteger(config.pids) && config.pids >= 16 && config.pids <= 256, 'RESOURCE_POLICY_REQUIRED');
  requireCondition(['scanner', 'node-entry'].includes(config.executionMode), 'EXECUTION_MODE_REQUIRED');
  if (config.executionMode === 'node-entry') requireCondition(typeof config.containerNodeExecutable === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(config.containerNodeExecutable)
    && !config.containerNodeExecutable.split('/').includes('..') && /^[a-f0-9]{64}$/.test(config.containerNodeSha256 ?? ''), 'IMAGE_NODE_RUNTIME_UNQUALIFIED');
  for (const name of ['runtimeIdentity', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef'])
    requireCondition(typeof config[name] === 'string' && config[name].length > 0 && config[name].length <= 1000 && !/[\x00-\x1f]/.test(config[name]), 'ACCEPTED_CONTEXT_MISSING');
  requireCondition(config.currentClaim && /^[a-f0-9-]{36}$/.test(config.currentClaim.claimId ?? '')
    && ['fence', 'epoch'].every(k => Number.isSafeInteger(config.currentClaim[k]) && config.currentClaim[k] > 0)
    && Date.parse(config.currentClaim.expiresAt) > Date.now(), 'CLAIM_EXPIRED');
  for (const name of ['nodeExecutable', 'gitExecutable', 'entryFile', 'sourceManifestFile', 'publicKeyFile', 'qualificationFile', 'signingKeyFile', 'workspaceRoot', 'runsRoot', 'trustedSourceDirectory'])
    requireCondition(typeof config[name] === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(config[name]) && !config[name].split('/').includes('..'), 'FIXED_PATH_REQUIRED');
  const roots = ['workspaceRoot', 'runsRoot', 'trustedSourceDirectory'].map(k => config[k]);
  requireCondition(new Set(roots).size === roots.length && roots.every((r, i) => roots.every((other, j) => i === j || !r.startsWith(other + '/'))), 'CONTROL_DIRECTORY_OVERLAP');
  requireCondition(!roots.some(root => [config.signingKeyFile, config.qualificationFile, config.publicKeyFile].some(f => f === root || f.startsWith(root + '/'))), 'SIGNER_MOUNT_OVERLAP');
}
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
export async function loadQualifiedPolicy(configPath = '/etc/clued-independent-ci/launcher.json') {
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
    [fileURLToPath(new URL('./linux-launcher.mjs', import.meta.url)), config.launcherSha256],
    [fileURLToPath(import.meta.url), config.qualificationSha256],
    [fileURLToPath(new URL('../src/worker.mjs', import.meta.url)), config.workerSha256],
    [fileURLToPath(new URL('../src/proof.mjs', import.meta.url)), config.proofSha256],
    [fileURLToPath(new URL('../src/queue.mjs', import.meta.url)), config.queueSha256]]) {
    await protectedPath(filename);
    requireCondition(/^[a-f0-9]{64}$/.test(pin ?? '') && sha256(await readFile(filename)) === pin, 'RUNTIME_SOURCE_DRIFT');
  }
  requireCondition(process.execPath === config.nodeExecutable, 'UNPINNED_NODE_RUNTIME');
  const sourceManifestBytes = await readFile(config.sourceManifestFile);
  requireCondition(sha256(sourceManifestBytes) === config.sourceManifestSha256, 'MANIFEST_HASH_MISMATCH');
  const qualification = JSON.parse(await readFile(config.qualificationFile, 'utf8'));
  const publicKey = await readFile(config.publicKeyFile);
  requireCondition(qualification && Object.keys(qualification).length === 2 && verify(null, Buffer.from(canonicalJson(qualification.payload)), publicKey, Buffer.from(qualification.signature, 'base64')), 'QUALIFICATION_SIGNATURE_REFUSED');
  const q = qualification.payload;
  requireCondition(q.schema === 'independent-ci.runtime-qualification.v1' && q.fixture === false && q.runtimeIdentity === config.runtimeIdentity
    && q.sourceManifestSha256 === config.sourceManifestSha256 && q.image === config.image && q.entrySha256 === config.entrySha256
    && q.launcherSha256 === config.launcherSha256 && q.qualificationSha256 === config.qualificationSha256
    && q.executionMode === config.executionMode && q.workerSha256 === config.workerSha256 && q.proofSha256 === config.proofSha256 && q.queueSha256 === config.queueSha256
    && (config.executionMode === 'scanner' || q.containerNodeExecutable === config.containerNodeExecutable && q.containerNodeSha256 === config.containerNodeSha256)
    && q.keyId === config.keyId && q.resultPublicKeySha256 === sha256(publicKey), 'QUALIFICATION_BINDING_REFUSED');
  requireCondition(q.isolation === 'root-managed-single-job-container' && q.prCannotReadSignerKey === true && q.noControllerMounts === true && q.noCredentials === true && q.networkDisabled === true && q.cleanupQualified === true, 'ISOLATION_UNQUALIFIED');
  requireCondition(q.hostAcceptanceRef === config.hostAcceptanceRef && q.sourceAcceptanceRef === config.sourceAcceptanceRef && typeof q.hostAcceptanceRef === 'string' && q.hostAcceptanceRef.length > 10 && typeof q.sourceAcceptanceRef === 'string' && q.sourceAcceptanceRef.length > 10, 'OWNER_ACCEPTANCE_MISSING');
  requireCondition(Date.parse(q.expiresAt) > Date.now() && Date.parse(q.qualifiedAt) <= Date.now(), 'QUALIFICATION_EXPIRED');
  requireCondition(config.currentClaim && Date.parse(config.currentClaim.expiresAt) > Date.now(), 'CLAIM_EXPIRED');
  return { config, sourceManifestBytes, qualification, publicKey };
}
