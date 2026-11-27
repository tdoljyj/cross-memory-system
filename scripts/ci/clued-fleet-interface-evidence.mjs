import { deliveryBound } from '../../work/independent-ci-resident-v1/rollout/fleet/delivery-preflight.mjs';
import { migrationTreeDigest } from '../../work/independent-ci-resident-v1/rollout/fleet/previous-interface-check.mjs';

const contract = 'clued.fleet-previous-interface.v1';
const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;

// The protected workflow receives this output only from its own successful
// replay job. Bind it to the independently checked inputs before sealing.
export async function verifyInterfaceEvidence(env, { candidate, acceptanceSha256 }, readPrevious) {
  const missing = 'FLEET_DELIVERY_PREVIOUS_INTERFACE_EVIDENCE_REQUIRED';
  const mismatch = 'FLEET_DELIVERY_PREVIOUS_INTERFACE_EVIDENCE_MISMATCH';
  if (!env.FLEET_INTERFACE_RESULT) throw new Error(missing);
  let result;
  try { result = JSON.parse(env.FLEET_INTERFACE_RESULT); } catch { throw new Error(missing); }
  if (result?.status !== 'PASS' || result.runId !== env.GITHUB_RUN_ID || result.workflowCommit !== env.GITHUB_SHA ||
      !/^[1-9][0-9]{0,19}$/.test(result.runId) || !sha.test(result.workflowCommit) || env.GITHUB_RUN_ATTEMPT !== '1' ||
      !deliveryBound(result.candidate, candidate) || !sha.test(candidate.commit) || !digest.test(acceptanceSha256) ||
      !Number.isSafeInteger(result.checkedAt) || !digest.test(result.migrationsSha256 ?? '')) {
    throw new Error(mismatch);
  }
  const migrationsSha256 = migrationTreeDigest(candidate.commit);
  if (result.migrationsSha256 !== migrationsSha256) throw new Error(mismatch);
  const previous = await readPrevious(candidate);
  if (!deliveryBound(result.previous, previous) || previous.commit === candidate.commit) throw new Error(mismatch);
  const { workflowCommit, runId, checkedAt } = result;
  return { migrationsSha256, previousInterfaceEvidence: { contract, status: 'PASS', candidate, previous, migrationsSha256,
    acceptanceSha256, workflowCommit, runId, checkedAt } };
}
