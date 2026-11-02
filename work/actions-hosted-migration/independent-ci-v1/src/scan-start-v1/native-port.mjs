// Protected Windows controller port. The Linux side receives only a closed,
// first-insert grant through the fixed bridge, never a Native credential.
import { validateJobV2 } from '../job-v2.mjs';
import { validateFormalAdmissionV2 } from '../admission-facts-v2.mjs';
import { REPOSITORY, REPOSITORY_ID } from '../hosted-relay-v1/registry.mjs';
import { validateScanStartGrant } from './grant.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code = 'SCAN_START_NATIVE_UNCONFIRMED') => { if (!ok) fail(code); };
const safePath = v => typeof v === 'string' && v.length > 0 && v.length < 4096
  && !/[\\:\x00-\x1f\x7f]/.test(v) && !v.startsWith('/') && !v.split('/').some(p => !p || p === '.' || p === '..');

export function createIndependentScanStartPort({ native, github, registrySha256, scope, live = () => {}, clock = Date.now }) {
  check(native && typeof native.command === 'function' && typeof native.current === 'function'
    && typeof github?.readChangedPaths === 'function' && HASH.test(registrySha256)
    && typeof scope === 'string' && /^project:[0-9a-f-]{36}$/.test(scope));
  const attempted = new Set();
  return async ({ job, facts, executionId }) => {
    live(); validateJobV2(job); validateFormalAdmissionV2(job, facts, clock());
    check(job.repo === REPOSITORY && UUID.test(executionId) && facts.scope === scope
      && facts.sourceManifestSha256 === job.sourceManifestSha256 && facts.batchClaimBound
      && facts.claimId === facts.batchClaimBound.claimId && facts.fence === facts.batchClaimBound.fence
      && facts.epoch === facts.batchClaimBound.epoch);
    // Even a transport failure never retries a potentially consumed permission
    // in this issuer. Native's global K remains the cross-process boundary.
    check(!attempted.has(executionId), 'SCAN_START_ALREADY_ATTEMPTED');
    attempted.add(executionId);
    const packet = await github.readChangedPaths(job); live();
    check(packet?.complete === true && packet.pr === job.pr && packet.headSha === job.headSha && packet.baseSha === job.baseSha
      && Array.isArray(packet.paths) && packet.paths.length > 0 && packet.paths.length <= 10000
      && packet.paths.every(safePath) && new Set(packet.paths).size === packet.paths.length);
    validateFormalAdmissionV2(job, facts, clock());
    const paths = [...packet.paths].sort();
    const identity = { job, claim: { claim_id: facts.claimId, fence: facts.fence, execution_epoch: facts.epoch } };
    const mode = { scope, paths, executionPolicy: facts.executionPolicy, guarded: facts.guarded };
    check(await native.current(identity, mode)); live();
    const answer = await native.command({ action: 'scan_start_independent', scope,
      repository_id: REPOSITORY_ID, repository: job.repo, execution_id: executionId,
      claim_id: facts.claimId, fence: facts.fence, epoch: facts.epoch, pr: job.pr,
      head_sha: job.headSha, base_sha: job.baseSha, changed_paths: paths, role: job.role,
      source_manifest_sha256: job.sourceManifestSha256, registry_sha256: registrySha256 });
    live();
    const grant = validateScanStartGrant(answer, { job, executionId, repositoryId: REPOSITORY_ID });
    // A source/claim change after the burn only stops the launch; it never
    // releases the key or manufactures a no-start proof.
    check(await native.current(identity, mode)); live();
    return grant;
  };
}
