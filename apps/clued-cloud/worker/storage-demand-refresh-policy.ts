const DAY = 86_400_000;
const KEEPALIVE = 30 * DAY;
const MARGIN = 300_000;

export type StorageRenewalTiming = {
  enabled: boolean;
  connection_active: boolean;
  pending_exchange: boolean;
  needs_provider_work: boolean;
  credential_expires_at_ms: number | null;
  last_successful_exchange_at_ms: number | null;
  backoff_until_ms?: number | null;
};
export type StorageRenewalWake = { kind: "disabled" | "pending" | "observe" | "active" | "keepalive"; at_ms: number | null };

/** Scheduling metadata is operational state, never permission. The Native due
 * evaluator still checks the live delegation, source and connection before use.
 * Unknown credential expiry is observed first; a retry timestamp is not expiry.
 */
export function storageRenewalWake(timing: StorageRenewalTiming, now: number): StorageRenewalWake {
  if (!Number.isFinite(now)) throw new Error("storage_renewal_clock_invalid");
  if (!timing.enabled || !timing.connection_active) return { kind: "disabled", at_ms: null };
  if (timing.pending_exchange) return { kind: "pending", at_ms: null };
  const expiry = timing.credential_expires_at_ms;
  if (expiry === null) return { kind: "observe", at_ms: now };
  if (!Number.isFinite(expiry)) throw new Error("storage_renewal_expiry_invalid");
  const backoff = timing.backoff_until_ms ?? null;
  if (backoff !== null && !Number.isFinite(backoff)) throw new Error("storage_renewal_backoff_invalid");
  if (timing.needs_provider_work) return { kind: "active", at_ms: Math.max(now, expiry - MARGIN, backoff ?? now) };
  const last = timing.last_successful_exchange_at_ms;
  if (last === null) return { kind: "observe", at_ms: now };
  if (!Number.isFinite(last) || last > now) throw new Error("storage_renewal_exchange_time_invalid");
  return { kind: "keepalive", at_ms: Math.max(now, last + KEEPALIVE, backoff ?? now) };
}
