import path from 'node:path';
import { canonical, digest } from '../proof.mjs';
import { nodeIdentityOf, nodeIdentitySha256 } from '../../../../independent-ci-resident-v1/src/node-identity.mjs';
import { assertProtectedPaths, readProtected } from '../../runtime/protected-files.mjs';

const fields = ['activatedAt', 'baseNodeIdentitySha256', 'bindingGeneration', 'bindingId', 'contract', 'previousSha256', 'rebindReceiptId', 'tokenPinSha256'];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const valid = (pattern, value) => typeof value === 'string' && pattern.test(value);
function refuse(code = 'CI_CONNECTION_RECORD_REFUSED') {
  throw Object.assign(new Error(code), { code });
}

// 调用方已按安装合同核验 record。只有确实缺少当前记录才采用安装时的值。
export function effectiveCiPrincipal(record, bytes) {
  if (bytes === null) return { bindingId: record.config.ciPrincipalBindingId, tokenPinSha256: record.accepted.ciTokenPinSha256, generation: null };
  try {
    const raw = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    if (!(raw instanceof Uint8Array) || !raw.length || raw.length > 4096) refuse();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    const current = JSON.parse(text);
    if (!current || Object.getPrototypeOf(current) !== Object.prototype || Object.keys(current).sort().join('|') !== fields.join('|')
      || canonical(current) !== text || current.contract !== 'clued.independent-ci.ci-connection/1'
      || !Number.isSafeInteger(current.bindingGeneration) || current.bindingGeneration < 1
      || !valid(uuid, current.bindingId) || !valid(uuid, current.rebindReceiptId) || !valid(hash, current.tokenPinSha256)
      || !(current.previousSha256 === null || valid(hash, current.previousSha256))
      || !valid(/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, current.activatedAt)
      || new Date(current.activatedAt).toISOString() !== current.activatedAt) refuse();
    const identity = nodeIdentityOf(record.config, record.accepted, record.hashes.acceptanceSha256);
    if (current.baseNodeIdentitySha256 !== nodeIdentitySha256(identity)) refuse();
    return { bindingId: current.bindingId, tokenPinSha256: current.tokenPinSha256, generation: current.bindingGeneration };
  } catch { refuse(); }
}

export async function readCiCredential(record, { tokenFile, protect = assertProtectedPaths, tokenReader = readProtected }) {
  const secretRoot = path.dirname(tokenFile);
  const root = path.dirname(secretRoot);
  const options = { secret: true, secretRoot, controllerSid: record.accepted.node.controllerSid };
  const connectionFile = path.join(secretRoot, 'ci-admission.connection.json');
  let connection = null;
  try {
    // 生产检查仅在确认可选文件存在时返回 true；既有注入端口只校验必需路径。
    if ((await protect(root, [tokenFile], false, connectionFile)) === true) {
      connection = await tokenReader(connectionFile, options);
      if (connection == null) refuse();
    }
  } catch { refuse(); }
  const principal = effectiveCiPrincipal(record, connection);
  const nativeToken = (await tokenReader(tokenFile, options)).trim();
  if (!/^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(nativeToken)
    || digest('clued.independent-ci.ci-binding-pin/1\0' + nativeToken) !== principal.tokenPinSha256) refuse('ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED');
  return { bindingId: principal.bindingId, nativeToken, bindingGeneration: principal.generation };
}
