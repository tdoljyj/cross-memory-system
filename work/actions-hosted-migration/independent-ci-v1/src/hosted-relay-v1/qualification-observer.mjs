// Protected-entry building block, not an executable qualification entry.
// Reuses the production E1-E8 observer and signature verifier. No dispatch,
// publishing, token output, caller-provided PASS or installation side effect.
// The accepted held-Source entry must supply its installed ports and perform
// Source/claim/principal/session admission before calling this module.
import { createHash } from 'node:crypto';
import { createHostedRelayObserver } from './observe.mjs';
import { createGitHubOidcVerifier, createJwksPort, parseJwks } from './oidc.mjs';
import { attestRole } from './attest.mjs';
import { isValidatedRegistry, registryDigestOf, relayFail } from './registry.mjs';
import { canonical } from '../proof.mjs';

const HEX40 = /^[a-f0-9]{40}$/;
const HASH = value => createHash('sha256').update(canonical(value)).digest('hex');
const CLAIMS = ['iss', 'aud', 'repository', 'repository_id', 'repository_owner', 'repository_owner_id',
  'event_name', 'sub', 'ref', 'base_ref', 'head_ref', 'job_workflow_ref', 'workflow_ref',
  'runner_environment', 'run_id', 'run_attempt', 'sha', 'workflow_sha', 'job_workflow_sha', 'iat', 'check_run_id'];

function publicClaims(claims) {
  const copy = {};
  for (const key of CLAIMS) {
    if (!Object.hasOwn(claims, key)) continue;
    const value = claims[key];
    // Include only bounded verified primitive claims. jti, unknown claims and
    // raw/hex JWTs never leave this module, including on a refusal.
    if (typeof value === 'string' && value.length <= 512) copy[key] = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) copy[key] = value;
    else relayFail('QUALIFICATION_VERIFIED_CLAIM_SHAPE');
  }
  return Object.freeze(copy);
}

const PUBLIC_CODES = new Set(['QUALIFICATION_VERIFIED_CLAIM_SHAPE', 'QUALIFICATION_FULL_ANNOTATIONS_REQUIRED',
  'QUALIFICATION_ATTESTATION_REFUSED', 'QUALIFICATION_REF_MOVEMENT_UNCONFIRMED', 'QUALIFICATION_BEFORE_REF_UNCONFIRMED',
  'QUALIFICATION_OLD_MERGE_UNREADABLE', 'RELAY_OBSERVATION_UNCONFIRMED', 'OIDC_JWKS_UNAVAILABLE',
  'OIDC_ORIGIN_REFUSED', 'OIDC_JWKS_TOO_LARGE', 'OIDC_JWKS_INVALID', 'OIDC_TOKEN_MALFORMED',
  'OIDC_HEADER_REFUSED', 'OIDC_ALG_REFUSED', 'OIDC_KID_UNKNOWN', 'OIDC_SIGNATURE_INVALID',
  'OIDC_ISSUER_MISMATCH', 'OIDC_AUDIENCE_MISMATCH']);
function safeCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' && PUBLIC_CODES.has(descriptor.value)
      ? descriptor.value : 'QUALIFICATION_OBSERVATION_UNCONFIRMED';
  } catch { return 'QUALIFICATION_OBSERVATION_UNCONFIRMED'; }
}

// This returns bounded observations only: even verified evidence cannot grant
// live qualification without the exclusive controller and independent attestation.
export function createQualificationObserver({ github, registry, fetchImpl, clock = Date.now } = {}) {
  if (!isValidatedRegistry(registry) || typeof fetchImpl !== 'function' || typeof clock !== 'function')
    relayFail('QUALIFICATION_OBSERVER_CONFIGURATION');
  const network = createJwksPort({ fetchImpl });
  // Private provenance, never a caller-supplied beforeSha flag. Durable cross-
  // process restoration needs the protected journal; until implemented a new
  // observer instance cannot claim a ref moved during an earlier process.
  const beforeRefs = new Map();
  const refKey = (pr, headSha) => `${pr}:${headSha}`;
  return Object.freeze({
    currentMergeObservation({ pr, headSha }) {
      const sha = beforeRefs.get(refKey(pr, headSha));
      if (!sha) return null;
      return Object.freeze({ ref: `refs/pull/${pr}/merge`, beforeRefSha: sha,
        afterRefSha: sha, oldMergeSha: sha, oldMergeReadBySha: true });
    },
    async observe(subject) {
      const roles = subject?.roles;
      if (!Array.isArray(roles) || roles.length !== 2 || roles[0] !== 'gitleaks' || roles[1] !== 'trivy')
        relayFail('QUALIFICATION_BOTH_ROLES_REQUIRED');
      const base = { contract: 'clued.hosted-relay-qualification-observation/1',
        liveQualified: false, authority: 'OBSERVATION_ONLY',
        fixture: github.fixture === true, registrySha256: registryDigestOf(registry) };
      try {
        const annotations = new Map();
        const observedGithub = Object.freeze({ ...github, async readCheckRunAnnotations(id, count) {
          const packet = await github.readCheckRunAnnotations(id, count);
          if (packet?.complete === true && Array.isArray(packet.annotations) && packet.annotations.length === count)
            annotations.set(id, { count, sha256: HASH(packet.annotations) });
          return packet;
        } });
        const observer = createHostedRelayObserver({ github: observedGithub, registry, clock });
        const facts = await observer.observe(subject);
        const beforeRef = await github.readPullRequest(facts.pr);
        // Deliberately bypass BOTH disk and in-memory verifier caches for each
        // observation. One fixed-origin GET is mandatory even for a known kid.
        const jwks = await network.fetchJwks();
        parseJwks(jwks);
        const verifier = createGitHubOidcVerifier({ audience: registry.audience,
          jwksPort: { async fetchJwks() { return jwks; } }, cache: null, clock,
          fixture: github.fixture === true });
        const results = [];
        for (const role of roles) {
          const annotation = facts.tokenAnnotations[role];
          if (annotation?.complete !== true || annotation.matches?.length !== 1 || typeof annotation.matches[0] !== 'string')
            relayFail('QUALIFICATION_FULL_ANNOTATIONS_REQUIRED');
          const verification = await verifier.verify(annotation.matches[0]);
          const verdict = attestRole({ registry, role, facts, verification, mode: 'relay' });
          if (verdict.verdict !== 'ATTESTED_SUCCESS') relayFail('QUALIFICATION_ATTESTATION_REFUSED');
          const complete = annotations.get(verdict.envelope.checkRunId);
          if (!complete) relayFail('QUALIFICATION_FULL_ANNOTATIONS_REQUIRED');
          const claims = publicClaims(verification.claims);
          const checkRunIdPresent = Object.hasOwn(verification.claims, 'check_run_id');
          results.push(Object.freeze({ role, checkRunId: verdict.envelope.checkRunId,
            runId: verdict.envelope.runId, runAttempt: verdict.envelope.runAttempt,
            annotationsComplete: true, identityAnnotationCount: annotation.matches.length,
            totalAnnotationCount: complete.count, fullAnnotationsSha256: complete.sha256,
            verifiedClaims: claims, claimsSha256: HASH(claims),
            tokenSha256: verification.tokenSha256,
            keyThumbprintSha256: verification.keyThumbprintSha256,
            oldMergeSha: verdict.envelope.mergeSha, oldMergeReadBySha: true,
            checkRunIdPresent, registryBindsCheckRunId: registry.requireCheckRunIdClaim === true,
            attestationSha256: verdict.envelope.attestationSha256 }));
        }
        // c326@1: L1 is followed by a mandatory true binding and a new Source.
        // Absence of the claim is not permission to retain a false registry.
        const registryRepinRequired = registry.requireCheckRunIdClaim !== true;
        if (beforeRef?.number === facts.pr && beforeRef.state === 'open' && beforeRef.draft === false
          && beforeRef.head?.sha === facts.headSha && beforeRef.head?.repo?.full_name === registry.repository
          && beforeRef.base?.repo?.full_name === registry.repository && beforeRef.base?.ref === registry.baseRef
          && HEX40.test(beforeRef.merge_commit_sha ?? '') && results.every(r => r.oldMergeSha === beforeRef.merge_commit_sha))
          beforeRefs.set(refKey(facts.pr, facts.headSha), beforeRef.merge_commit_sha);
        const result = { ...base, status: registryRepinRequired ? 'REGISTRY_REPIN_REQUIRED' : 'OBSERVATIONS_VERIFIED_NO_QUALIFICATION',
          repository: facts.repository, pr: facts.pr, headSha: facts.headSha, baseSha: facts.baseSha,
          freshJwksGetCompleted: true, jwksSha256: HASH(jwks),
          registryRepinRequired, roles: Object.freeze(results) };
        return Object.freeze({ ...result, observationSha256: HASH(result) });
      } catch (error) {
        // Do not serialize errors, tokens, annotation text, unverified claims,
        // response bodies or partially verified role output.
        return Object.freeze({ ...base, status: 'OBSERVATION_REFUSED', code: safeCode(error) });
      }
    },
    // Observe an actual changed PR merge ref, then independently read the OLD
    // merge object by SHA. This never moves refs or executes another head.
    async observeOldMergeAfterMovement({ pr, headSha, oldMergeSha }) {
      if (!Number.isSafeInteger(pr) || pr < 1 || !HEX40.test(headSha ?? '') || !HEX40.test(oldMergeSha ?? ''))
        relayFail('QUALIFICATION_OLD_MERGE_SUBJECT');
      try {
        if (beforeRefs.get(refKey(pr, headSha)) !== oldMergeSha)
          relayFail('QUALIFICATION_BEFORE_REF_UNCONFIRMED');
        const current = await github.readPullRequest(pr);
        if (current?.number !== pr || current.state !== 'open' || current.draft !== false
          || current.head?.sha !== headSha || current.head?.repo?.full_name !== registry.repository
          || current.base?.repo?.full_name !== registry.repository || current.base?.ref !== registry.baseRef
          || !HEX40.test(current.merge_commit_sha ?? '') || current.merge_commit_sha === oldMergeSha)
          relayFail('QUALIFICATION_REF_MOVEMENT_UNCONFIRMED');
        const old = await github.readGitCommit(oldMergeSha);
        if (old?.sha !== oldMergeSha || !HEX40.test(old.tree ?? '') || !Array.isArray(old.parents)
          || old.parents.length !== 2 || old.parents[1] !== headSha || !HEX40.test(old.parents[0] ?? ''))
          relayFail('QUALIFICATION_OLD_MERGE_UNREADABLE');
        const result = { contract: 'clued.hosted-relay-old-merge-observation/1', liveQualified: false,
          authority: 'OBSERVATION_ONLY', fixture: github.fixture === true, repository: registry.repository,
          pr, headSha, ref: `refs/pull/${pr}/merge`, beforeRefSha: oldMergeSha,
          afterRefSha: current.merge_commit_sha, oldMergeSha, oldMergeReadBySha: true,
          oldMergeTreeSha: old.tree, movementObserved: true };
        return Object.freeze({ ...result, observationSha256: HASH(result) });
      } catch (error) {
        return Object.freeze({ contract: 'clued.hosted-relay-old-merge-observation/1', liveQualified: false,
          authority: 'OBSERVATION_ONLY', status: 'OBSERVATION_REFUSED', code: safeCode(error) });
      }
    },
  });
}
