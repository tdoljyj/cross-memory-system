import { createStorageCredentialVault, type StorageCredentialContext, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageFetch } from "./storage-fetch";
import { bytesToBase64Url } from "./storage-base64";
import { isStorageScopeProfile, scopeProfile, scopeString, type StorageScopeProfile } from "./storage-google-scopes";

const encoder = new TextEncoder();
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (): never => { throw new Error("storage_google_connection_unavailable"); };
export class StorageGoogleConnectionError extends Error {
  constructor(readonly reason: string) { super("storage_google_connection_unavailable"); }
}
// Private, fixed classifications only: never retain an upstream body/cause.
class TokenExchangeFailure extends Error {
  constructor(readonly reason: string) { super("storage_google_token_exchange_failed"); }
}
const base64 = (b: Uint8Array) => bytesToBase64Url(b);
// Database labels that the page maps to fixed text (StorageNormalUse §2.4).
const startReason: Record<string, string> = Object.freeze({
  storage_root_has_unresolved_mutation: "storage_root_busy",
  storage_refresh_token_limit: "refresh_token_limit",
}) as Record<string, string>;
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s))), b => b.toString(16).padStart(2, "0")).join("");
type RecordValue = Record<string, unknown>;
type Descriptor = {
  owner_id: string; connection_id: string; connection_version: number; credential_version: number;
  provider_subject: string | null; oauth_client_id: string; redirect_uri: string; root_folder_id: string; root_parent_id: string;
};
function context(d: Descriptor, subject: string): StorageCredentialContext {
  return { owner_id: d.owner_id, connection_id: d.connection_id, provider: "google-drive", provider_subject: subject,
    oauth_client_id: d.oauth_client_id, credential_version: d.credential_version };
}
function descriptor(raw: RecordValue, client: string, redirect: string): Descriptor {
  if (!id.test(String(raw.owner_id)) || !id.test(String(raw.connection_id)) || raw.oauth_client_id !== client || raw.redirect_uri !== redirect ||
      !Number.isSafeInteger(raw.connection_version) || Number(raw.connection_version) < 1 ||
      !Number.isSafeInteger(raw.credential_version) || Number(raw.credential_version) < 1 ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(String(raw.root_folder_id)) || !/^[A-Za-z0-9_-]{1,160}$/.test(String(raw.root_parent_id)) ||
      !(raw.provider_subject === null || (typeof raw.provider_subject === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(raw.provider_subject)))) fail();
  return raw as Descriptor;
}

/** Private server composition. rpc must authenticate the native user AND the
 * fixed connector issuer. Neither callback can be supplied by a browser/tool.
 * It performs no Drive create/update/delete and returns no provider tokens.
 */
export async function createStorageGoogleOAuth(configuration: {
  client_id: string; client_secret: string; redirect_uri: string;
  vault: Parameters<typeof createStorageCredentialVault>[0];
  rpc: (input: RecordValue) => Promise<RecordValue>;
  fetch?: typeof fetch;
  clock?: () => number;
}) {
  const { client_id: client, client_secret: clientSecret, redirect_uri: redirect, rpc } = configuration;
  const callback = new URL(redirect);
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(client) || typeof clientSecret !== "string" || clientSecret.length < 16 ||
      callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash ||
      callback.pathname !== "/storage/google/callback" || typeof rpc !== "function") fail();
  const vault = await createStorageCredentialVault(configuration.vault);
  const fetcher = createStorageFetch(configuration.fetch);
  const clock = configuration.clock ?? Date.now;
  async function json(url: string, init: RequestInit, tokenExchange = false): Promise<RecordValue> {
    let received = false;
    try {
      const response = await fetcher(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(10000) });
      received = true;
      if (!response.ok && !tokenExchange) fail();
      const text = await response.text();
      if (text.length > 65536) fail();
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) fail();
      if (!response.ok) {
        const reason = (value as RecordValue).error;
        const known = new Set(["invalid_client", "invalid_grant", "unauthorized_client", "invalid_request", "unsupported_grant_type"]);
        throw new TokenExchangeFailure(typeof reason === "string" && known.has(reason)
          ? "token_" + reason : "token_http_rejected");
      }
      return value as RecordValue;
    } catch (error) {
      if (tokenExchange) throw error instanceof TokenExchangeFailure ? error :
        new TokenExchangeFailure(received ? "token_response_unreadable" : "token_transport_unconfirmed");
      return fail();
    }
  }
  return Object.freeze({
    async inspectRecovery(state: string): Promise<{ status: string; receipt_id: string | null; execution_permitted: false }> {
      if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) fail();
      const result = await rpc({ action: "inspect", state_hash: await hash(state) });
      if (result.purpose !== "credential_recovery" || !["prepared", "claimed", "completed", "expired"].includes(String(result.status)) ||
        typeof result.status !== "string" || result.execution_permitted !== false ||
        !(result.receipt_id === null || (typeof result.receipt_id === "string" && id.test(result.receipt_id))) ||
        (result.status === "completed" && result.receipt_id === null)) fail();
      return { status: result.status as string, receipt_id: result.receipt_id as string | null, execution_permitted: false };
    },
    /** scopeRequest (StorageNormalUse §2.2-§2.4):
     * - "legacy": the legacy set;
     * - "keep": the profile the connection row records (a plain reconnect never
     *   downgrades a normal connection);
     * - "normal": the normal set, for normal use on an existing connection
     *   (re-consent, §2.4); `normalUse` binds the disclosure the Owner confirmed;
     * - "sealed": exactly the recorded profile, as credential recovery must:
     *   recovery never upgrades or downgrades. Its prepare contract takes no
     *   extra key, so nothing but the base fields is sent.
     * Connection consent binds the requested profile to the attempt; complete
     * then accepts only that profile or legacy (the Owner may untick a scope). */
    async start(connectionId: string, defaultRefresh = false, scopeRequest: "legacy" | "keep" | "normal" | "sealed" = "legacy",
      normalUse?: { disclosure_version: string }): Promise<{ authorization_url: string }> {
      try {
        if (!id.test(connectionId) || !["legacy", "keep", "normal", "sealed"].includes(scopeRequest) ||
          (normalUse !== undefined && (scopeRequest !== "normal" || !normalUse || Object.keys(normalUse).length !== 1 ||
            typeof normalUse.disclosure_version !== "string" || !/^[A-Za-z0-9._/-]{1,160}$/.test(normalUse.disclosure_version)))) fail();
        const described = await rpc({ action: "describe", connection_id: connectionId });
        const d = descriptor(described, client, redirect);
        if (d.connection_id !== connectionId) fail();
        let requested: StorageScopeProfile = scopeRequest === "normal" ? "normal" : "legacy";
        if (scopeRequest === "sealed" || scopeRequest === "keep") {
          if (!isStorageScopeProfile(described.provider_scope_profile)) fail();
          requested = described.provider_scope_profile as StorageScopeProfile;
        }
        const attempt = crypto.randomUUID(), state = base64(crypto.getRandomValues(new Uint8Array(32)));
        const verifier = base64(crypto.getRandomValues(new Uint8Array(32)));
        const challenge = base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
        const sealed = await vault.seal(verifier, context(d, "oauth_" + attempt));
        const stored = await rpc({ action: "prepare", connection_id: d.connection_id, connection_version: d.connection_version,
          attempt_id: attempt, state_hash: await hash(state), verifier_envelope: sealed,
          ...(scopeRequest === "sealed" ? {} : { requested_scope_profile: requested }),
          ...(normalUse ? { normal_use: { disclosure_version: normalUse.disclosure_version } } : {}),
          ...(defaultRefresh ? { default_refresh_consent: (d as Descriptor & { default_refresh_eligible?: boolean }).default_refresh_eligible === true } : {}) });
        if (stored.status !== "prepared") fail();
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        url.search = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: "code", scope: scopeString(requested),
          state, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", include_granted_scopes: "false" }).toString();
        return { authorization_url: url.href };
      } catch (error) {
        // Fixed database labels only (§2.4 items 3 and 8); everything else stays generic.
        const known = error instanceof Error ? startReason[error.message] : undefined;
        if (known) throw new StorageGoogleConnectionError(known);
        return fail();
      }
    },
    async complete(input: { state: string; code: string }): Promise<{ status: "completed"; receipt_id: string; refresh_enabled?: boolean;
      purpose?: "credential_recovery"; provider_scope_profile?: StorageScopeProfile; requested_scope_profile?: StorageScopeProfile;
      normal_use_enabled?: boolean }> {
      // Only these fixed local stage names leave this boundary. Never expose an
      // upstream body, exception, code, state, token, subject or provider file ID.
      let stage = "callback_invalid";
      // A completion, or its replay after a lost reply: only typed, known fields.
      const completed = (result: RecordValue) => ({ status: "completed" as const, receipt_id: String(result.receipt_id),
        ...(result.purpose === "credential_recovery" ? { purpose: "credential_recovery" as const } : {
          ...(typeof result.refresh_enabled === "boolean" ? { refresh_enabled: result.refresh_enabled } : {}),
          ...(isStorageScopeProfile(result.provider_scope_profile) ? { provider_scope_profile: result.provider_scope_profile } : {}),
          ...(isStorageScopeProfile(result.requested_scope_profile) ? { requested_scope_profile: result.requested_scope_profile } : {}),
          ...(typeof result.normal_use_enabled === "boolean" ? { normal_use_enabled: result.normal_use_enabled } : {}) }) });
      try {
        if (!input || Object.keys(input).length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(input.state) ||
            typeof input.code !== "string" || input.code.length < 8 || input.code.length > 4096 || /[\r\n]/.test(input.code)) fail();
        const stateHash = await hash(input.state);
        stage = "attempt_unavailable";
        const claimed = await rpc({ action: "claim", state_hash: stateHash });
        if (claimed.status === "completed" && id.test(String(claimed.receipt_id))) return completed(claimed);
        const d = descriptor(claimed, client, redirect);
        if (claimed.status !== "claimed" || !id.test(String(claimed.attempt_id))) fail();
        stage = "verifier_unavailable";
        const verifier = await vault.open(claimed.verifier_envelope as StorageCredentialEnvelope, context(d, "oauth_" + claimed.attempt_id));
        if (!/^[A-Za-z0-9_-]{43}$/.test(verifier)) fail();
        // Conservative lifetime: later metadata requests never extend expiry.
        const requestedAt = clock(); if (!Number.isFinite(requestedAt)) fail();
        stage = "token_exchange_unconfirmed";
        const tokens = await json("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: client, client_secret: clientSecret, redirect_uri: redirect,
            code: input.code, code_verifier: verifier, grant_type: "authorization_code" }).toString() }, true);
        stage = "token_response_invalid";
        if (tokens.token_type !== "Bearer" || typeof tokens.access_token !== "string" || tokens.access_token.length < 16 ||
            !Number.isInteger(tokens.expires_in) || Number(tokens.expires_in) < 120 || Number(tokens.expires_in) > 86400) fail();
        stage = "refresh_token_missing";
        if (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length < 16) fail();
        stage = "scope_mismatch";
        // Connection consent accepts the requested profile or legacy (the user may
        // untick a scope on the consent page) and records what was granted; the
        // requested profile is bound to the attempt (§2.3). Credential recovery
        // must return exactly the sealed profile (§2.2 item 7). The database
        // checks the same.
        const granted = scopeProfile(tokens.scope);
        if (granted === null) fail();
        if (claimed.purpose === "credential_recovery") {
          if (!isStorageScopeProfile(claimed.provider_scope_profile) || claimed.provider_scope_profile !== granted) fail();
        } else {
          const requested = claimed.requested_scope_profile ?? "legacy";
          if (!isStorageScopeProfile(requested) || (granted !== requested && granted !== "legacy")) fail();
        }
        const headers = { authorization: "Bearer " + tokens.access_token };
        stage = "provider_identity_unconfirmed";
        const about = await json("https://www.googleapis.com/drive/v3/about?fields=user(permissionId,me)", { headers });
        const user = about.user as RecordValue | undefined;
        const subject = typeof user?.permissionId === "string" ? user.permissionId : "";
        if (!user || user.me !== true || !/^[A-Za-z0-9_-]{1,255}$/.test(subject) ||
            (d.provider_subject !== null && d.provider_subject !== subject)) fail();
        stage = "root_metadata_unavailable";
        const root = await json("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(d.root_folder_id) +
          "?fields=id,parents,mimeType,trashed,capabilities(canAddChildren),isAppAuthorized", { headers });
        stage = "root_identity_mismatch";
        if (root.id !== d.root_folder_id || root.mimeType !== "application/vnd.google-apps.folder" || root.trashed !== false) fail();
        stage = "root_not_authorized";
        if (root.isAppAuthorized !== true) fail();
        stage = "root_not_writable";
        if ((root.capabilities as RecordValue)?.canAddChildren !== true) fail();
        stage = "root_parent_mismatch";
        if (!Array.isArray(root.parents) || root.parents.length !== 1 || root.parents[0] !== d.root_parent_id) fail();
        stage = "token_lifetime_insufficient";
        const now = clock(), expiresAt = requestedAt + Number(tokens.expires_in) * 1000;
        if (!Number.isFinite(now) || now < requestedAt || expiresAt - now < 60000) fail();
        stage = "credential_seal_unavailable";
        const sealed = await vault.seal(JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token,
          token_type: "Bearer", scope: scopeString(granted!), expires_at_ms: expiresAt }), context(d, subject));
        stage = "credential_commit_unconfirmed";
        let result: RecordValue;
        try {
          result = await rpc({ action: "complete", state_hash: stateHash, provider_subject: subject, credential_envelope: sealed,
            provider_scope_profile: granted });
        } catch (error) {
          // A fixed database refusal is a rolled-back commit, not an unknown one.
          if (error instanceof Error && startReason[error.message]) stage = startReason[error.message];
          throw error;
        }
        if (result.status !== "completed" || !id.test(String(result.receipt_id))) fail();
        return completed(result);
      } catch (error) { throw new StorageGoogleConnectionError(error instanceof TokenExchangeFailure ? error.reason : stage); }
    },
  });
}
