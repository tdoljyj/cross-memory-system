// The words of a withdrawn (revoked) publication. A check is withdrawn when its authorization could not be confirmed after
// it was written. When the cause is only that GitHub could not be read (a 5xx that outlived the bounded read retry of
// read-retry.mjs, a network failure), nothing was found to have CHANGED: the title and the summary must say that the
// verification was unavailable, never "authorization changed". The reason code stays the cause (github_http_502, ...).
// full_admission_unavailable: the admission port could not finish its evaluation (any exception inside it, typically a GitHub or
// Native read), so nothing was found to have changed either.
// Exactly the faults the bounded read retry (read-retry.mjs RETRYABLE_STATUSES) treats as passing: 500/502/503/504 and a network failure. A 429 (rate limit),
// a 501 or any other 5xx is not one of them and keeps the ordinary wording; the entry's safeToRerun (staged-check-publisher-v2) uses the same set.
const READ_UNAVAILABLE = /^(?:github_http_(?:500|502|503|504)|github_transport_unconfirmed|full_admission_unavailable)$/;
export const verificationUnavailable = cause => READ_UNAVAILABLE.test(cause ?? '');
// Generation 10 (resident DESIGN 53.6): the stage-1 work admission's verification after its own write is read again (bounded) and, when
// it still cannot be done, its withdrawal is the transient ADMISSION_VERIFICATION_UNAVAILABLE (stage-fact.mjs) only for a PASSING cause:
//   - GitHub not readable (500/502/503/504, no transport);
//   - full_admission_unavailable only when its diagnostic says the evaluation caught a transport fault (full-admission-v2.mjs
//     #transportFault); a credential refused, a 401/403 or an evaluator fault inside it is not passing;
//   - an observation that was incomplete or too old on a slow line: the mode or the observer could not be read in time, the Native
//     observation expired before it was used, or the after-write observation expired before the read-back finished. Pre-write these
//     are transient too (stage-fact.mjs TRANSPORT_REASONS); a fresh evaluation is all they need.
// A changed binding, a read-back that disagrees and every other refusal stay final (PUBLICATION_REVOKED).
export const ADMISSION_REREAD_REASONS = Object.freeze(['full_admission_mode_unknown', 'full_admission_observer_unknown', 'full_admission_observation_expired',
  'NATIVE_OBSERVATION_EXPIRED_AFTER_WRITE']);
export const admissionVerificationRetryable = (cause, diagnostic = null) => (cause === 'full_admission_unavailable' ? diagnostic?.transport === true : verificationUnavailable(cause))
  || ADMISSION_REREAD_REASONS.includes(cause);
// subject: 'Work admission' | 'Independent control' | 'Independent CI'. unavailable: the cause is "could not be verified" (default: the
// read set above; the work admission also passes its reread reasons).
export const withdrawalTitle = (subject, cause, unavailable = verificationUnavailable(cause)) => unavailable ? `${subject} check withdrawn: verification unavailable` : `${subject} authorization changed`;
export const withdrawalNote = (cause, unavailable = verificationUnavailable(cause)) => unavailable
  ? ' GitHub or Native could not be read in time to confirm the authorization after the write; no change of it was observed. The check is withdrawn rather than left unverified.' : '';
