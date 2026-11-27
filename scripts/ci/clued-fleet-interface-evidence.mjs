import { createHmac } from 'node:crypto';
import { deliveryBound } from '../../work/independent-ci-resident-v1/rollout/fleet/delivery-preflight.mjs';
import { migrationTreeDigest } from '../../work/independent-ci-resident-v1/rollout/fleet/previous-interface-check.mjs';

const contract = 'clued.fleet-previous-interface.v1';
const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;

// The privileged job signs only its own replay job's output after rechecking
// the published candidate and recomputing the migration tree digest.
export function sealInterfaceEvidence(env, { candidate, acceptanceSha256 }, readDigest = migrationTreeDigest) {
  const missing = 'FLEET_DELIVERY_PREVIOUS_INTERFACE_EVIDENCE_REQUIRED';
  if (!env.FLEET_INTERFACE_RESULT) throw new Error(missing);
  let result;
  try { result = JSON.parse(env.FLEET_INTERFACE_RESULT); } catch { throw new Error(missing); }
  const { repository, version, commit, archiveSha256, requestSha256 } = result?.previous ?? {};
  const previous = { repository, version, commit, archiveSha256, requestSha256,
    acceptanceSha256: result?.previous?.acceptanceSha256 };
  if (result?.status !== 'PASS' || result.runId !== env.GITHUB_RUN_ID || result.workflowCommit !== env.GITHUB_SHA ||
      !/^[1-9][0-9]{0,19}$/.test(result.runId) || !sha.test(result.workflowCommit) || env.GITHUB_RUN_ATTEMPT !== '1' ||
      !deliveryBound(result.candidate, candidate) || !sha.test(candidate.commit) || !digest.test(acceptanceSha256) ||
      previous.repository !== candidate.repository || !/^g[0-9]{6}$/.test(previous.version) ||
      previous.version >= candidate.version || !sha.test(previous.commit) || previous.commit === candidate.commit ||
      ![previous.archiveSha256, previous.requestSha256, previous.acceptanceSha256].every(value => digest.test(value)) ||
      !Number.isSafeInteger(result.checkedAt) || !digest.test(result.migrationsSha256 ?? '') ||
      result.migrationsSha256 !== readDigest(candidate.commit)) {
    throw new Error('FLEET_DELIVERY_PREVIOUS_INTERFACE_EVIDENCE_MISMATCH');
  }
  const key = env.CLUED_FLEET_INTERFACE_PROOF_KEY ?? '';
  if (!digest.test(key)) throw new Error('FLEET_DELIVERY_PREVIOUS_INTERFACE_KEY_REQUIRED');
  const { migrationsSha256 } = result;
  const payload = JSON.stringify({ contract, status: 'PASS', candidate, previous, migrationsSha256, acceptanceSha256,
    workflowCommit: result.workflowCommit, runId: result.runId, checkedAt: result.checkedAt });
  const mac = createHmac('sha256', Buffer.from(key, 'hex')).update(payload).digest('hex');
  return { migrationsSha256, previousInterfaceEvidence: { payload, mac } };
}
