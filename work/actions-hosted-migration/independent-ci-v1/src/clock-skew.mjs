// Clock skew (Decision 1100a0ed). freshStamp: a stamp of this host (or of the Windows side read by the Linux worker,
// admission-facts-v2.mjs) may read up to CLOCK_SKEW_MS in the checking host's future; freshness stays at most
// maxAgeMs: now - stamped in [-CLOCK_SKEW_MS, maxAgeMs]. KooYomi's own stamps are never compared with a local clock:
// serverAnswerCurrent below. The bridge v4 protocol keeps its own issuedAt/expiresAt rules (unchanged here).
export const CLOCK_SKEW_MS = 5000;
export const FRESH_MS = 30_000;

export function freshStamp(stampedMs, now, maxAgeMs = FRESH_MS) {
  return Number.isFinite(stampedMs) && Number.isSafeInteger(now) && stampedMs <= now + CLOCK_SKEW_MS && now - stampedMs <= maxAgeMs;
}

// A time stamped elsewhere that must not lie in this host's future (beyond the skew).
export const notFuture = (stampedMs, now) => Number.isFinite(stampedMs) && stampedMs <= now + CLOCK_SKEW_MS;

// A KooYomi answer used as live authority, with no comparison across clocks (Decision 1100a0ed: DESK passed and
// failed the same input within 0.36 s). Its age is bounded by this host's monotonic clock: verified_at lies inside the
// call, so now - sentMono bounds it (at most maxAgeMs). The lease is compared server time to server time: expires_at -
// verified_at must outlast that age plus LEASE_MARGIN_MS. verified_at is checked for form only. Returns the names of
// the failed checks (empty when current); never values.
export const LEASE_MARGIN_MS = 5000;
const ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/;
export function serverAnswerCurrent({ verifiedAt, expiresAt, sentMono, nowMono, maxAgeMs = FRESH_MS }) {
  const failed = [], verified = ISO_MS.test(verifiedAt ?? '') ? Date.parse(verifiedAt) : NaN;
  const expires = ISO_MS.test(expiresAt ?? '') ? Date.parse(expiresAt) : NaN, age = nowMono - sentMono;
  if (!Number.isFinite(verified)) failed.push('verified_at_form');
  if (!Number.isFinite(expires)) failed.push('expires_at_form');
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) failed.push('round_trip_age');
  if (!failed.length && !(expires - verified > age + LEASE_MARGIN_MS)) failed.push('lease_remaining');
  return failed;
}
