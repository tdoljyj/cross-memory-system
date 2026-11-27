import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonical, digest } from '../proof.mjs';
import { readCiCredential } from './ci-principal.mjs';
import { WIN_ROOT } from './layout.mjs';
import path from 'node:path';

const NODE_GATEWAY = 'https://kooyumi.pixelgrav.com/v1/ci/node';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
function requireFact(ok) {
  if (!ok) throw Object.assign(new Error('ci_train_protocol_unconfirmed'), { code: 'ci_train_protocol_unconfirmed' });
}

export function validTrainInstall(record) {
  const { mergeTrainProtocolVersion: version, mergeTrainNode: node, scope } = record;
  if (version === undefined || version === 1) return node === undefined;
  return version === 2 && node && Object.getPrototypeOf(node) === Object.prototype
    && Object.keys(node).sort().join('|') === 'atomicLandingQualificationRef|keyFingerprint|nodeId|projectId|tenantId'
    && [node.nodeId, node.projectId, node.tenantId].every(value => UUID.test(value ?? ''))
    && HASH.test(node.keyFingerprint ?? '') && UUID.test(node.atomicLandingQualificationRef ?? '') && scope === 'project:' + node.projectId;
}

async function signTrainCommand(text) {
  const script = fileURLToPath(new URL('./sign-train-command.ps1', import.meta.url));
  const { stdout } = await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', script, '-CommandBase64', Buffer.from(text).toString('base64')],
    { windowsHide: true, timeout: 5000, maxBuffer: 1024 });
  return stdout.trim();
}

export async function openTrainTransport(record, live, {
  readCredential = readCiCredential, fetchImpl = globalThis.fetch, sign = signTrainCommand, clock = Date.now,
} = {}) {
  const config = record.config;
  if (config.mergeTrainProtocolVersion !== 2) return undefined;
  requireFact(validTrainInstall(config));
  const pinned = config.mergeTrainNode;
  const { nativeToken, bindingId, bindingGeneration } = await readCredential(record, {
    tokenFile: path.join(WIN_ROOT, 'secrets', 'ci-admission.token'),
  });
  async function post(url, input) {
    live();
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(15000), headers: { authorization: 'Bearer ' + nativeToken, 'content-type': 'application/json' },
      body: JSON.stringify(input) });
    requireFact(response.ok && (!response.url || response.url === url));
    const value = await response.json();
    live();
    return value;
  }
  const status = await post(NODE_GATEWAY + '/status', { node_id: pinned.nodeId });
  const { node } = status;
  requireFact(status.status === 'ok' && status.gateway_open === true && node?.node_id === pinned.nodeId
    && node.user_id === pinned.tenantId && node.project_id === pinned.projectId && node.binding_id === bindingId
    && node.identity_fingerprint === pinned.keyFingerprint && positive(node.version) && positive(node.key_version)
    && positive(node.binding_generation) && (bindingGeneration === null || node.binding_generation === bindingGeneration));
  const scope = Object.freeze({ contextKey: config.scope, repositoryId: config.repositoryId, targetBranch: 'main',
    tenantId: pinned.tenantId, projectId: pinned.projectId });
  return Object.freeze({ nodeId: node.node_id, bindingGeneration: node.binding_generation, scope, async command(payload) {
    const signedPayload = JSON.parse(JSON.stringify(payload));
    const issued = clock();
    const command = { protocol: 'clued.ci-node-command/1', operation: 'merge_train_v2',
      user_id: node.user_id, project_id: node.project_id, binding_id: node.binding_id, binding_generation: node.binding_generation,
      node_id: node.node_id, node_version: node.version, key_version: node.key_version, key_fingerprint: node.identity_fingerprint,
      payload_sha256: digest(signedPayload), nonce: randomBytes(32).toString('base64url'),
      job_id: null, execution_generation: 0, train_generation: 0, issued_at_ms: issued, expires_at_ms: issued + 60000 };
    live();
    const signature = await sign(canonical(command));
    requireFact(typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature));
    const reply = await post(NODE_GATEWAY, { command: { ...command, signature }, payload: signedPayload });
    requireFact(reply.status === 'committed' && reply.operation === command.operation && reply.result?.protocol_version === 2);
    return reply.result;
  } });
}
