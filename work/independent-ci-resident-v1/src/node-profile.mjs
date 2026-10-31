// Pure resident-side twin of Source resident-v2/prepare-record.mjs#validateNodeProfile.
// The resident is installed separately from CI Source; never import across those installed roots.
import { check, digest, HEX64 } from './canonical.mjs';

export const NODE_PROFILE_CONTRACT = 'clued.independent-ci.node-profile/1';
export const NODE_PROFILE_KEYS = Object.freeze(['contract', 'nodeName', 'hostname', 'ownerSid', 'ownerProfileDirectory', 'controllerSid', 'runnerService', 'mutationMutex', 'wslDistribution']);
const SID = /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-(\d{1,10})$/;
export function validateNodeProfile(n) {
  check(n !== null && typeof n === 'object' && Object.getPrototypeOf(n) === Object.prototype
    && Object.keys(n).sort().join('|') === [...NODE_PROFILE_KEYS].sort().join('|')
    && NODE_PROFILE_KEYS.every(k => typeof n[k] === 'string') && n.contract === NODE_PROFILE_CONTRACT, 'NODE_PROFILE_FIELDS_REQUIRED');
  const owner = SID.exec(n.ownerSid), controller = SID.exec(n.controllerSid);
  check(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(n.nodeName) && /^[A-Z0-9](?:[A-Z0-9-]{0,13}[A-Z0-9])?$/.test(n.hostname)
    && owner && controller && n.ownerSid !== n.controllerSid && Number(controller[1]) >= 1000
    && /^C:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(n.ownerProfileDirectory)
    && /^actions\.runner\.tdoljyj-cross-memory-system\.clued-ci-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(n.runnerService)
    && n.mutationMutex === `Global\\CluedControlControllerMutationV1-${n.hostname}-${controller[1]}`
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(n.wslDistribution), 'NODE_PROFILE_INVALID');
  return n;
}
export const nodeProfileSha256 = n => digest(validateNodeProfile(n));
export function pinnedNodeProfile(node, expected) {
  check(HEX64.test(expected ?? '') && nodeProfileSha256(node) === expected, 'NODE_PROFILE_PIN_CHANGED');
  return Object.freeze({ ...node });
}
