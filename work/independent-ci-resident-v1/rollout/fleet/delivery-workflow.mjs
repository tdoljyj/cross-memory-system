import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { deliveryBound } from './delivery-preflight.mjs';

const WORKFLOW = 'clued-cloud-production-release.yml';
const KEY = /^[A-Za-z0-9_-]{59}$/;
const PACKET = 'CLUED_FLEET_DELIVERY_V1';
const LIMIT = 256 * 1024;
export const STAGED_REQUEST_MAX_BYTES = 12 * 1024;
export const STAGED_PAYLOAD_MAX_LENGTH = 24 * 1024;
const aad = requestSha256 => Buffer.from(requestSha256, 'hex');
const publicBytes = key => key.export({ type: 'spki', format: 'der' }).toString('base64url');

function derive(privateKey, publicText, requestSha256) {
  if (!KEY.test(publicText)) throw new Error('FLEET_DELIVERY_KEY_REFUSED');
  const publicKey = createPublicKey({ key: Buffer.from(publicText, 'base64url'), type: 'spki', format: 'der' });
  if (publicKey.asymmetricKeyType !== 'x25519') throw new Error('FLEET_DELIVERY_KEY_REFUSED');
  return hkdfSync('sha256', diffieHellman({ privateKey, publicKey }), aad(requestSha256), PACKET, 32);
}

export function deliveryWorkflowPacket(value, publicText, requestSha256) {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > LIMIT) throw new Error('FLEET_DELIVERY_RESULT_TOO_LARGE');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(privateKey, publicText, requestSha256), iv);
  cipher.setAAD(aad(requestSha256));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return [PACKET, publicBytes(publicKey), Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')].join(' ');
}

function openPacket(log, privateKey, requestSha256) {
  const lines = log.split(/\r?\n/).flatMap(line => {
    const match = new RegExp(PACKET + ' ([A-Za-z0-9_-]{59}) ([A-Za-z0-9_-]+)$').exec(line);
    return match ? [match] : [];
  });
  if (lines.length !== 1 || lines[0][2].length > (LIMIT + 28) * 2) throw new Error('FLEET_DELIVERY_LOG_REFUSED');
  const [, sender, payload] = lines[0];
  const bytes = Buffer.from(payload, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', derive(privateKey, sender, requestSha256), bytes.subarray(0, 12));
  cipher.setAAD(aad(requestSha256));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
}

export function deliveryWorkflowRun(runGh, repository, runId, candidateCommit) {
  if (!/^[1-9][0-9]*$/.test(runId)) throw new Error('FLEET_DELIVERY_WORKFLOW_RUN_UNKNOWN');
  const run = ['run', 'view', runId, '--repo', repository, '--attempt', '1'];
  const read = args => {
    const result = runGh([...run, ...args]);
    if (result.status !== 0) throw new Error('FLEET_DELIVERY_WORKFLOW_UNAVAILABLE');
    return result.stdout;
  };
  return {
    status: () => {
      const state = JSON.parse(read(['--json', 'status,conclusion,attempt,event,headBranch,headSha']));
      if (state.attempt !== 1 || state.event !== 'workflow_dispatch' || state.headBranch !== 'main') {
        throw new Error('FLEET_DELIVERY_WORKFLOW_RUN_UNKNOWN');
      }
      if (candidateCommit && state.headSha !== candidateCommit) throw new Error('FLEET_DELIVERY_SUBJECT_CHANGED');
      return state;
    },
    log: () => read(['--log']),
  };
}

export function deliveryWorkflowClient({ runGh, sleep }) {
  return async (operation, candidate, details, { signal, onDispatch }) => {
    const { repository, version, requestSha256 } = candidate;
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const call = args => {
      signal.throwIfAborted();
      const r = runGh(args);
      if (r.status !== 0) throw new Error('FLEET_DELIVERY_WORKFLOW_UNAVAILABLE');
      return r.stdout;
    };
    // 暂存登记核对使用现有 project 输入，只传回包公钥和待发布请求。
    const key = publicBytes(publicKey);
    let deliveryInput = key;
    if (operation === 'preflight') {
      const { requestBytes } = details;
      if (requestBytes.length > STAGED_REQUEST_MAX_BYTES) throw new Error('FLEET_DELIVERY_STAGED_INPUT_TOO_LARGE');
      const payload = Buffer.from(JSON.stringify({ request: requestBytes.toString('base64url') })).toString('base64url');
      if (payload.length > STAGED_PAYLOAD_MAX_LENGTH) throw new Error('FLEET_DELIVERY_STAGED_INPUT_TOO_LARGE');
      deliveryInput = `${key}.${payload}`;
    }
    const dispatched = call(['workflow', 'run', WORKFLOW, '--repo', repository, '--ref', 'main', '-f', 'mode=fleet-accept',
      '-f', 'fleet_operation=' + (operation === 'preflight' ? 'project' : operation),
      '-f', 'fleet_version=' + version, '-f', 'fleet_request_sha256=' + requestSha256,
      '-f', 'fleet_delivery_key=' + deliveryInput,
      ...(operation === 'confirm' ? ['-f', 'fleet_acceptance_sha256=' + details.acceptanceSha256] : [])]);
    const match = dispatched.match(/https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)\s*$/);
    if (match?.[1] !== repository) throw new Error('FLEET_DELIVERY_WORKFLOW_RUN_UNKNOWN');
    await onDispatch?.(match[2]);
    const run = deliveryWorkflowRun(args => {
      signal.throwIfAborted();
      return runGh(args);
    }, repository, match[2], operation === 'preflight' ? candidate.commit : undefined);
    for (;;) {
      const state = run.status();
      if (state.status === 'completed') {
        if (state.conclusion !== 'success') throw Object.assign(new Error('FLEET_DELIVERY_WORKFLOW_REFUSED'), { workflowCompleted: true });
        const value = openPacket(run.log(), privateKey, requestSha256);
        if (value.operation !== operation || !deliveryBound(value.candidate, candidate)) throw new Error('FLEET_DELIVERY_SUBJECT_CHANGED');
        return value.result;
      }
      await sleep(2000);
    }
  };
}
