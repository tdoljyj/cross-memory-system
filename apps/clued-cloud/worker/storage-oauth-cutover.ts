export interface StorageOAuthCutoverEnv {
  CLUED_STORAGE_OAUTH_STARTS_PAUSED?: string;
}

export function storageOAuthStartsPaused(env: StorageOAuthCutoverEnv): boolean {
  return env.CLUED_STORAGE_OAUTH_STARTS_PAUSED === "true";
}

// Pause new consent preparations only; existing callbacks and credential renewal
// must keep draining. Call after the route's Origin, method and feature checks.
export function storageOAuthStartMaintenance(
  env: StorageOAuthCutoverEnv, pathname: string, headers: HeadersInit, action?: unknown,
): Response | null {
  if (!storageOAuthStartsPaused(env)) return null;
  if (!["/v1/storage/google/start", "/v1/storage/google/recovery/start",
    "/v1/storage/google/recovery/auto-start", "/v1/storage/onboard/begin"].includes(pathname)
    && !(pathname === "/v1/storage/lifecycle" && action === "reconnect")) return null;
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("retry-after", "60");
  return Response.json({ error: "Storage connection setup is temporarily unavailable. Please try again shortly." },
    { status: 503, headers: responseHeaders });
}
