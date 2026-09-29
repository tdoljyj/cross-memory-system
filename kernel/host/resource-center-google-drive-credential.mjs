const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPES = ["https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata.readonly"].sort().join(" ");
const scopeKey = (value) => typeof value === "string" ? value.trim().split(/\s+/).sort().join(" ") : "";

/** Host-only refresh of an existing explicitly consented pilot grant. No
 * authorization URL, new scope, provider override or caller token is accepted.
 * Storage/encryption belongs to the supervised Host, never to an Agent tool. */
export function createGoogleDrivePilotCredential({
  client_id: clientId, client_secret: clientSecret, load_tokens: loadTokens,
  persist_rotated_tokens: persistRotatedTokens, fetch: fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (typeof clientId !== "string" || !clientId.endsWith(".apps.googleusercontent.com") ||
    typeof clientSecret !== "string" || clientSecret.length < 16 || typeof loadTokens !== "function" ||
    (persistRotatedTokens !== undefined && typeof persistRotatedTokens !== "function") ||
    typeof fetchImpl !== "function" || typeof clock !== "function") {
    throw new TypeError("A Host-held client and encrypted token loader are required.");
  }
  let cached;
  let pending;
  let failed = false;
  function valid(t) {
    return t && t.token_type === "Bearer" && typeof t.access_token === "string" && t.access_token.length >= 16 &&
      typeof t.refresh_token === "string" && t.refresh_token.length >= 16 &&
      Number.isFinite(t.expires_at) && scopeKey(t.scope) === SCOPES;
  }
  async function credential() {
    if (failed) throw new Error("DRIVE_CREDENTIAL_REAUTHENTICATION_REQUIRED");
    try {
      if (!cached) {
        const loaded = await loadTokens();
        if (!valid(loaded)) throw new Error();
        cached = structuredClone(loaded);
      }
      if (cached.expires_at <= clock() + 60_000) {
        const response = await fetchImpl(TOKEN_ENDPOINT, { method: "POST", redirect: "error", cache: "no-store",
          headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
            refresh_token: cached.refresh_token, grant_type: "refresh_token" }) });
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (body.token_type !== "Bearer" || typeof body.access_token !== "string" || body.access_token.length < 16 ||
          !Number.isInteger(body.expires_in) || body.expires_in < 120 || body.expires_in > 86_400 ||
          (body.scope !== undefined && scopeKey(body.scope) !== SCOPES) ||
          (body.refresh_token !== undefined && (typeof body.refresh_token !== "string" || body.refresh_token.length < 16))) {
          throw new Error();
        }
        const next = { token_type: "Bearer", access_token: body.access_token,
          refresh_token: body.refresh_token ?? cached.refresh_token, scope: cached.scope,
          expires_at: clock() + body.expires_in * 1000 };
        // A provider rotation must be durably stored before publishing it.
        if (next.refresh_token !== cached.refresh_token) {
          if (!persistRotatedTokens) throw new Error();
          await persistRotatedTokens(Object.freeze({ ...next }));
        }
        cached = next;
      }
      return Object.freeze({ access_token: cached.access_token, scope: cached.scope });
    } catch {
      cached = undefined;
      failed = true;
      // Provider errors can contain credentials. Never propagate their text.
      throw new Error("DRIVE_CREDENTIAL_REFRESH_FAILED");
    }
  }
  return async function getCredential() {
    if (!pending) pending = credential().finally(() => { pending = undefined; });
    return pending;
  };
}
