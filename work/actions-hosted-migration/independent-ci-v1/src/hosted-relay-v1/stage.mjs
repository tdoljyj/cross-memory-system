// Hosted relay stage R (design S17, §4.1-§4.2, §7.3). Runs inside the
// protected control principal (clued-control), started by the resident
// executor after stage 1 and before any local role. For each relay candidate
// role it decides RELAYED (App 5368905 published the required check from a
// verified GitHub-hosted run) or LOCAL_REQUIRED(reason). It never executes PR
// content: it only reads the GitHub API and verifies a GitHub-signed token.
//
// Ordering per role: observe -> verify OIDC -> attest E1-E8 -> publisher
// (fresh re-attestation, fresh Native admission E9, K(head, role) and the
// relay's own effect key E10, POST, read-back). Any verdict other than
// ATTESTED_SUCCESS, and any refusal before K is held, leaves the role to the
// local path. Once K is held by the relay, every outcome other than a settled
// publication is RELAY_PUBLICATION_UNCERTAIN: the stage stops, later roles are
// NOT_PROCESSED, and the executor burns the head and HALTs (PR886 §6.3).
// A role this node knows nothing of whose check App 5368905 already published on
// the head (another node or install; resident primary/standby design v0.4 §6.2,
// C4) is ON_GITHUB: nothing is sent for it, later relayable roles are
// NOT_PROCESSED, and the executor ends the batch cleanly (ROLE_ALREADY_ON_GITHUB),
// never running a local role for it.
import { digest } from '../proof.mjs';
import { attestHead, validateHostedEnvelope } from './attest.mjs';
import { HEAVY_ROLES, RELAYABLE_ROLES, ROLE_INPUT_PINS, isValidatedRegistry, registryDigestOf, relayFail } from './registry.mjs';
import { ROLE_ALREADY_ON_GITHUB, ROLE_ALREADY_ON_GITHUB_REASON } from '../published-on-github-v2.mjs';

export const RELAY_STAGE_CONTRACT = 'clued.independent-ci.hosted-relay-stage/1';
export const RELAY_CODES = Object.freeze({
  PUBLICATION_UNCERTAIN: 'RELAY_PUBLICATION_UNCERTAIN',
  ROLE_ALREADY_PUBLISHED_ON_HEAD: 'ROLE_ALREADY_PUBLISHED_ON_HEAD',
  ROLE_ALREADY_ON_GITHUB,
  STAGE_INPUT_INVALID: 'RELAY_STAGE_INPUT_INVALID',
  STAGE_NOT_CONFIGURED: 'RELAY_STAGE_NOT_CONFIGURED',
});
// LOCAL_REQUIRED reasons, all RELAY_NOT_ATTESTED_* (design S21 allow-list).
// RELAY_ROLE_NOT_RELAYABLE: a heavy role that is never relayed (contract-placement), or one
// absent from the installed registry; it is always local, whatever the hosted run did.
export const LOCAL_REASONS = Object.freeze(['RELAY_ROLE_NOT_RELAYABLE', 'RELAY_NOT_ATTESTED_BILLING_REFUSED', 'RELAY_NOT_ATTESTED_HOSTED_NOT_SUCCESS',
  'RELAY_NOT_ATTESTED_PENDING', 'RELAY_NOT_ATTESTED_ABSENT', 'RELAY_NOT_ATTESTED_NOT_ELIGIBLE', 'RELAY_NOT_ATTESTED_ATTESTATION_FAILED',
  'RELAY_NOT_ATTESTED_OBSERVATION_UNCONFIRMED', 'RELAY_NOT_ATTESTED_NOT_CONFIRMED', 'RELAY_NOT_ATTESTED_NOT_ADMITTED']);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SUBJECT_KEYS = ['baseSha', 'claimId', 'epoch', 'fence', 'headSha', 'pr', 'repo', 'sourceManifestSha256'];
const detailOf = error => (typeof error?.code === 'string' ? `${error.code}${typeof error.detail === 'string' ? `:${error.detail}` : ''}`.slice(0, 160) : 'unconfirmed');

// Observation plus OIDC plus E1-E8, used by the stage (first pass) and by the
// publisher (fresh confirmation immediately before the write).
//   attest({ subject, roles }) -> { factsSha256, verdicts: { role: verdict } }
//   confirm(envelope) -> { confirmed, attestationSha256?, reason? }
export function createHostedRelayVerifier({ registry, observer, oidc } = {}) {
  if (!isValidatedRegistry(registry) || typeof observer?.observe !== 'function' || typeof oidc?.verify !== 'function'
    || oidc.audience !== registry.audience || oidc.issuer !== registry.issuer
    || (registry.domain === 'fixture') !== (observer.fixture === true && oidc.fixture === true)
    || (registry.domain === 'production' && (observer.fixture === true || oidc.fixture === true))) relayFail(RELAY_CODES.STAGE_NOT_CONFIGURED, 'verifier');
  const registrySha256 = registryDigestOf(registry);
  async function attest({ subject, roles }) {
    const facts = await observer.observe({ repo: subject.repo, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, roles });
    const verifications = {};
    for (const role of roles) {
      const matches = facts.tokenAnnotations?.[role]?.matches;
      if (!Array.isArray(matches) || matches.length !== 1) continue;
      try { verifications[role] = await oidc.verify(matches[0]); }
      catch (error) { verifications[role] = { verified: false, error: detailOf(error) }; }
    }
    const head = attestHead({ registry, facts, verifications, mode: 'relay' });
    const verdicts = {};
    for (const role of roles) {
      const verdict = head.roles[role];
      // A token that failed signature verification reports why.
      const failure = verifications[role]?.verified === false && verdict.reason === 'E7_SIGNATURE_UNVERIFIED' ? verifications[role].error : null;
      verdicts[role] = failure ? { ...verdict, reason: `E7_${failure.split(':')[0]}` } : verdict;
    }
    return { factsSha256: digest(facts), billingRefused: head.billingRefused, verdicts };
  }
  return Object.freeze({
    fixture: registry.domain === 'fixture', registrySha256, publisherAppId: registry.publisherAppId,
    attest,
    async confirm(envelope) {
      validateHostedEnvelope(envelope);
      if (envelope.registrySha256 !== registrySha256 || !Object.hasOwn(registry.roles, envelope.role)) return { confirmed: false, reason: 'REGISTRY_CHANGED' };
      const subject = { repo: envelope.repository, pr: envelope.pr, headSha: envelope.headSha, baseSha: envelope.baseSha };
      const fresh = (await attest({ subject, roles: [envelope.role] })).verdicts[envelope.role];
      if (fresh.verdict !== 'ATTESTED_SUCCESS') return { confirmed: false, reason: fresh.reason ?? fresh.verdict };
      // The fresh attestation must name the very same run, merge commit,
      // closure, claims and token; a newer re-run or moved main refuses.
      if (fresh.envelope.attestationSha256 !== envelope.attestationSha256) return { confirmed: false, reason: 'ATTESTATION_CHANGED' };
      return { confirmed: true, attestationSha256: envelope.attestationSha256 };
    },
  });
}

function validInput(registry, input) {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join('|') !== 'attempt|roles|subject') return false;
  const { subject, attempt, roles } = input;
  return subject && typeof subject === 'object' && Object.keys(subject).sort().join('|') === SUBJECT_KEYS.join('|')
    && subject.repo === registry.repository && Number.isSafeInteger(subject.pr) && subject.pr > 0
    && SHA1.test(subject.headSha ?? '') && SHA1.test(subject.baseSha ?? '') && UUID.test(subject.claimId ?? '')
    && Number.isSafeInteger(subject.fence) && subject.fence > 0 && Number.isSafeInteger(subject.epoch) && subject.epoch > 0
    && SHA256.test(subject.sourceManifestSha256 ?? '') && Number.isSafeInteger(attempt) && attempt > 0 && attempt <= 9
    && Array.isArray(roles) && roles.length > 0 && new Set(roles).size === roles.length
    && roles.every(role => typeof role === 'string' && HEAVY_ROLES.includes(role));
}

// run({ subject, attempt, roles }) -> stage result (see RELAY_STAGE_CONTRACT below).
// `roles` are the relay candidates the executor wrote into 20-plan-intent.
// localInputPins: the installed local roles' own pins of hosted-job inputs ({ trivy: { checksDigest } }, from the
// installed Source manifest). A role whose registry pin is absent or differs is never relayed (PR-A round-3 review):
// the hosted run would not have used the local role's inputs.
export function createHostedRelayStage({ registry, verifier, publisher, localInputPins = {} } = {}) {
  const configured = isValidatedRegistry(registry) && typeof verifier?.attest === 'function' && typeof publisher?.publishHosted === 'function'
    && verifier.registrySha256 === registryDigestOf(registry) && (verifier.fixture === true) === (registry.domain === 'fixture')
    && (publisher.fixture === true) === (registry.domain === 'fixture');
  const registrySha256 = configured ? registryDigestOf(registry) : null;
  const finish = value => Object.freeze({ ...value, resultSha256: digest(value) });
  return Object.freeze({
    fixture: registry?.domain === 'fixture',
    async run(input) {
      const base = { contract: RELAY_STAGE_CONTRACT, registrySha256 };
      if (!configured) return finish({ ...base, status: 'REFUSED', code: RELAY_CODES.STAGE_NOT_CONFIGURED, pr: null, headSha: null, attempt: null, roles: [], sideEffects: 0 });
      if (!validInput(registry, input)) return finish({ ...base, status: 'REFUSED', code: RELAY_CODES.STAGE_INPUT_INVALID, pr: null, headSha: null, attempt: null, roles: [], sideEffects: 0 });
      const subject = Object.fromEntries(SUBJECT_KEYS.map(key => [key, input.subject[key]]));
      const roles = [...input.roles], attempt = input.attempt;
      const head = { ...base, pr: subject.pr, headSha: subject.headSha, attempt };
      const row = (role, outcome, fields = {}) => ({ role, outcome, reason: null, detail: null, verdict: null, attestationSha256: null,
        checkRunId: null, externalId: null, effectKey: null, roleMutexKey: null, receipt: null, ...fields });
      const local = (role, reason, detail, verdict, fields = {}) => row(role, 'LOCAL_REQUIRED', { ...fields, reason, detail, verdict,
        receipt: reason === 'RELAY_NOT_ATTESTED_BILLING_REFUSED' ? 'relay-billing-refused' : 'relay-local-fallback' });

      // Only registered relayable roles are observed; the rest are local without any read.
      const inputMismatch = role => {
        const pin = Object.hasOwn(ROLE_INPUT_PINS, role) ? ROLE_INPUT_PINS[role] : null;
        if (!pin) return null;
        const registered = registry.roles[role]?.[pin.field], installed = localInputPins?.[role]?.[pin.field];
        if (typeof registered !== 'string') return `${pin.field}_not_registered`;
        return registered === installed ? null : `${pin.field}_differs_from_installed_role`;
      };
      const relayable = roles.filter(role => Object.hasOwn(RELAYABLE_ROLES, role) && Object.hasOwn(registry.roles, role) && inputMismatch(role) === null);
      const never = role => local(role, 'RELAY_ROLE_NOT_RELAYABLE', !Object.hasOwn(RELAYABLE_ROLES, role) ? 'never_relayed'
        : !Object.hasOwn(registry.roles, role) ? 'not_registered' : inputMismatch(role), null);
      let first = { verdicts: {} };
      if (relayable.length) {
        try { first = await verifier.attest({ subject, roles: relayable }); }
        catch (error) {
          // Nothing was written: every candidate stays local.
          return finish({ ...head, status: 'COMPLETE', code: null, sideEffects: 0,
            roles: roles.map(role => relayable.includes(role) ? local(role, 'RELAY_NOT_ATTESTED_OBSERVATION_UNCONFIRMED', detailOf(error), null) : never(role)) });
        }
      }
      const rows = []; let sideEffects = 0, halt = null, onGithub = false;
      for (const role of roles) {
        if (!relayable.includes(role)) { rows.push(never(role)); continue; }
        if (halt || onGithub) { rows.push(row(role, 'NOT_PROCESSED')); continue; }
        const verdict = first.verdicts[role];
        if (verdict?.verdict !== 'ATTESTED_SUCCESS') {
          rows.push(local(role, `RELAY_NOT_ATTESTED_${verdict?.verdict ?? 'ATTESTATION_FAILED'}`, verdict?.reason ?? null, verdict?.verdict ?? null));
          continue;
        }
        let published;
        try { published = await publisher.publishHosted({ subject, attempt, envelope: verdict.envelope }); }
        catch (error) { published = { status: 'THROWN', reason: detailOf(error), sideEffects: 1, roleMutex: { key: null, held: true } }; }
        sideEffects += Number.isSafeInteger(published?.sideEffects) ? published.sideEffects : 1;
        const common = { verdict: verdict.verdict, attestationSha256: verdict.envelope.attestationSha256, effectKey: published?.effectKey ?? null,
          roleMutexKey: published?.roleMutex?.key ?? null };
        if (published?.status === 'SETTLED' && published.roleMutex?.held === true && Number.isSafeInteger(published.checkRunId)) {
          rows.push(row(role, 'RELAYED', { ...common, checkRunId: published.checkRunId, externalId: published.externalId, receipt: 'relay-attested' }));
          continue;
        }
        if (published?.status === 'REFUSED' && published.reason === 'role_already_published_on_head') {
          halt = RELAY_CODES.ROLE_ALREADY_PUBLISHED_ON_HEAD;
          // The publisher's own refusal behind the held K when it gives one (generation 13, review round 8 MINOR 2), else the reason.
          rows.push(row(role, 'HALT', { ...common, reason: halt, detail: published.detail ?? published.reason }));
          continue;
        }
        // Already on GitHub, unknown to this node (C4): nothing was sent and nothing more is published in this batch.
        if (published?.status === 'BLOCKED' && published.reason === ROLE_ALREADY_ON_GITHUB_REASON && published.roleMutex?.held === false && published.sideEffects === 0) {
          onGithub = true;
          rows.push(row(role, 'ON_GITHUB', { ...common, reason: RELAY_CODES.ROLE_ALREADY_ON_GITHUB, detail: published.reason }));
          continue;
        }
        // A role found on GitHub in any other shape is never sent to the local path: it HALTs below.
        if (published?.status === 'BLOCKED' && published.roleMutex?.held === false && published.reason !== ROLE_ALREADY_ON_GITHUB_REASON) {
          // Refused before K: nothing was sent and the local path stays open. This includes a GitHub read-back that
          // could not be completed (C4): the local publication reads GitHub back again before it publishes, and
          // refuses (fail closed) if that read is still incomplete.
          const notConfirmed = ['hosted_attestation_not_confirmed', 'hosted_attestation_invalid'].includes(published.reason);
          rows.push(local(role, notConfirmed ? 'RELAY_NOT_ATTESTED_NOT_CONFIRMED' : 'RELAY_NOT_ATTESTED_NOT_ADMITTED', published.reason ?? null, verdict.verdict, common));
          continue;
        }
        halt = RELAY_CODES.PUBLICATION_UNCERTAIN;
        rows.push(row(role, 'HALT', { ...common, reason: halt, detail: `${published?.status ?? 'UNKNOWN'}:${published?.reason ?? 'none'}`.slice(0, 160) }));
      }
      return finish({ ...head, status: halt ? 'HALT' : onGithub ? 'ON_GITHUB' : 'COMPLETE', code: halt ?? (onGithub ? RELAY_CODES.ROLE_ALREADY_ON_GITHUB : null), sideEffects, roles: rows });
    },
  });
}

// Companion hint mode (design §7.1): the same pure attestation over facts the
// companion read with the Owner's gh, without a signature check. Scheduling
// data only; it can make the executor wait or fall back, never publish.
export function hostedHint({ registry, facts }) {
  return attestHead({ registry, facts, mode: 'hint' });
}

