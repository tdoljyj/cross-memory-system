// The words of a withdrawn (revoked) publication. A check is withdrawn when its authorization could not be confirmed after
// it was written. When the cause is only that GitHub could not be read (a 5xx that outlived the bounded read retry of
// read-retry.mjs, a network failure), nothing was found to have CHANGED: the title and the summary must say that the
// verification was unavailable, never "authorization changed". The reason code stays the cause (github_http_502, ...).
const READ_UNAVAILABLE = /^(?:github_http_(?:429|5[0-9]{2})|github_transport_unconfirmed)$/;
export const verificationUnavailable = cause => READ_UNAVAILABLE.test(cause ?? '');
// subject: 'Work admission' | 'Independent control' | 'Independent CI'
export const withdrawalTitle = (subject, cause) => verificationUnavailable(cause) ? `${subject} check withdrawn: verification unavailable` : `${subject} authorization changed`;
export const withdrawalNote = cause => verificationUnavailable(cause)
  ? ' GitHub could not be read to confirm the authorization after the write; no change of it was observed. The check is withdrawn rather than left unverified.' : '';
