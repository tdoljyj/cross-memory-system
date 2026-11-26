import { createStorageCredentialVault, type StorageCredentialContext, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageFetch } from "./storage-fetch";
import { scopeProfile, scopeString, type StorageScopeProfile } from "./storage-google-scopes";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Data = Record<string, unknown>;
type FailureCode = "credential_validation" | "claim_deadline" | "token_invalid_grant" | "token_invalid_client"
  | "token_temporarily_unavailable" | "token_server_error" | "token_response_invalid" | "scope_changed"
  | "drive_identity_fetch" | "drive_identity_mismatch" | "root_metadata_fetch" | "root_identity_changed"
  | "root_access_changed" | "root_parent_changed" | "refresh_deadline" | "credential_seal_failure";
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const denied = () => new Error("storage_refresh_unavailable");

/** Server-only. Never exported by a browser/API route. A committed claim is the
 * single authorization to make one token request. Unknown outcomes retain it;
 * only an identical result commit (not the Google call) may be retried. */
export async function createStorageGoogleRefresh(config: {
  client_id: string; client_secret: string;
  vault: Parameters<typeof createStorageCredentialVault>[0];
  rpc: (input: Data) => Promise<Data>; fetch?: typeof fetch; clock?: () => number;
  claim_pause?: (milliseconds: number) => Promise<void>;
}) {
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id) || config.client_secret.length < 16) throw denied();
  const vault = await createStorageCredentialVault(config.vault), fetcher = createStorageFetch(config.fetch), clock = config.clock ?? Date.now;
  async function read(response: Response): Promise<Data> {
    const text = await response.text();
    if (text.length > 65536) throw denied();
    const value: unknown = JSON.parse(text); if (!object(value)) throw denied(); return value;
  }
  async function metadata(url: string, token: string): Promise<Data> {
    const response = await fetcher(url, { headers: { authorization: "Bearer " + token }, cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw denied(); return read(response);
  }
  return Object.freeze({
    async run(connection: string, recoveryJob?: string, demandProof?: string): Promise<{ status: string }> {
      if (!uuid.test(connection)) return { status: "unavailable" };
      if (recoveryJob !== undefined && !uuid.test(recoveryJob)) return { status: "unavailable" };
      if (demandProof !== undefined && !/^clued_srp_[0-9a-f]{64}$/.test(demandProof)) return { status: "unavailable" };
      const rpc = (input: Data) => config.rpc({...input,...(recoveryJob ? {recovery_job_id:recoveryJob} : {}),
        ...(demandProof ? {demand_proof:demandProof} : {})});
      const attempt = crypto.randomUUID();
      let claimed: Data;
      try {
        const claim = { action: "claim", connection_id: connection, attempt_id: attempt };
        claimed = await rpc(claim);
        // Only a definite Native busy result says no attempt was created. A
        // lost RPC reply is never retried and no Google exchange is repeated.
        for (let retry = 0; demandProof && claimed.status === "busy" && retry < 3; retry++) {
          if (claimed.connection_id !== connection || claimed.attempt_id !== attempt) return { status: "unavailable" };
          await (config.claim_pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds))))(100 * 2 ** retry);
          claimed = await rpc(claim);
        }
      }
      catch { return { status: "unavailable" }; }
      if (claimed.status !== "acquired") return { status: "not_acquired" };
      const failure = async (reason: "credential_invalid" | "provider_rejected" | "provider_unavailable", failure_code: FailureCode) => {
        // Only fixed codes cross this boundary. Never persist upstream bodies,
        // exception messages, URLs, credentials or stacks in a diagnostic.
        try { await rpc({ action: "fail", connection_id: connection, attempt_id: attempt, reason, failure_code }); }
        catch { /* Unknown settlement remains fenced. Never log the upstream data. */ }
        return { status: "unavailable" };
      };
      let context: StorageCredentialContext, previous: Data, deadline: number, profile: StorageScopeProfile | null = null;
      try {
        deadline = Date.parse(String(claimed.expires_at));
        if (claimed.connection_id !== connection || claimed.attempt_id !== attempt || !uuid.test(String(claimed.owner_id)) ||
            claimed.oauth_client_id !== config.client_id || !Number.isSafeInteger(claimed.credential_version) || Number(claimed.credential_version) < 1 ||
            !/^[A-Za-z0-9_-]{1,255}$/.test(String(claimed.provider_subject)) ||
            !/^[A-Za-z0-9_-]{1,160}$/.test(String(claimed.root_folder_id)) || !/^[A-Za-z0-9_-]{1,160}$/.test(String(claimed.root_parent_id)) ||
            !Number.isFinite(deadline) || deadline <= clock() || deadline > clock() + 121000) throw denied();
        context = { owner_id: String(claimed.owner_id), connection_id: connection, provider: "google-drive", provider_subject: String(claimed.provider_subject),
          oauth_client_id: config.client_id, credential_version: Number(claimed.credential_version) };
        previous = JSON.parse(await vault.open(claimed.credential_envelope as StorageCredentialEnvelope, context));
        if (object(previous)) profile = scopeProfile(previous.scope);
        if (!object(previous) || profile === null || previous.token_type !== "Bearer" || typeof previous.refresh_token !== "string" || previous.refresh_token.length < 16) throw denied();
      } catch { return failure("credential_invalid", "credential_validation"); }
      const start = clock();
      if (!Number.isFinite(start) || start >= deadline) return failure("credential_invalid", "claim_deadline");
      let response: Response, tokens: Data;
      try {
        response = await fetcher("https://oauth2.googleapis.com/token", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(10000),
          headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.client_id,
            client_secret: config.client_secret, grant_type: "refresh_token", refresh_token: String(previous.refresh_token) }).toString() });
        tokens = await read(response);
      } catch { return { status: "uncertain" }; } // Do not retry a potentially rotated refresh token.
      if (!response.ok) {
        if (tokens.error === "invalid_grant") return failure("provider_rejected", "token_invalid_grant");
        if (tokens.error === "invalid_client") return failure("provider_rejected", "token_invalid_client");
        if (!tokens.access_token && tokens.error === "temporarily_unavailable") return failure("provider_unavailable", "token_temporarily_unavailable");
        if (!tokens.access_token && tokens.error === "server_error") return failure("provider_unavailable", "token_server_error");
        return { status: "uncertain" };
      }
        // RFC 6749 allows omitted scope when unchanged. A refresh never changes
        // the sealed profile (StorageNormalUse §2.2 item 4): any other explicit
        // scope fails here and the connection needs fresh consent. An omitted
        // refresh_token preserves the existing one.
        if (tokens.token_type !== "Bearer" || typeof tokens.access_token !== "string" || tokens.access_token.length < 16 ||
            !Number.isInteger(tokens.expires_in) || Number(tokens.expires_in) < 120 || Number(tokens.expires_in) > 86400 ||
            (tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length < 16)))
          return failure("provider_rejected", "token_response_invalid");
        if (tokens.scope !== undefined && scopeProfile(tokens.scope) !== profile) return failure("provider_rejected", "scope_changed");
        let about: Data, root: Data;
        try { about = await metadata("https://www.googleapis.com/drive/v3/about?fields=user(permissionId,me)", tokens.access_token); }
        catch { return failure("provider_rejected", "drive_identity_fetch"); }
        if (!object(about.user) || about.user.me !== true || about.user.permissionId !== context.provider_subject)
          return failure("provider_rejected", "drive_identity_mismatch");
        try { root = await metadata("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(String(claimed.root_folder_id)) +
          "?fields=id,parents,mimeType,trashed,capabilities(canAddChildren),isAppAuthorized", tokens.access_token); }
        catch { return failure("provider_rejected", "root_metadata_fetch"); }
        if (root.id !== claimed.root_folder_id || root.mimeType !== "application/vnd.google-apps.folder" || root.trashed !== false)
          return failure("provider_rejected", "root_identity_changed");
        if ((profile !== "full" && root.isAppAuthorized !== true) || !object(root.capabilities) || root.capabilities.canAddChildren !== true)
          return failure("provider_rejected", "root_access_changed");
        if (!Array.isArray(root.parents) || root.parents.length !== 1 || root.parents[0] !== claimed.root_parent_id)
          return failure("provider_rejected", "root_parent_changed");
        const expires = start + Number(tokens.expires_in)*1000, now = clock();
        if (!Number.isFinite(now) || now < start || now >= deadline || expires - now <= 60000)
          return failure("provider_rejected", "refresh_deadline");
        let envelope: StorageCredentialEnvelope;
        try { envelope = await vault.seal(JSON.stringify({ access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? previous.refresh_token, token_type: "Bearer", scope: scopeString(profile!), expires_at_ms: expires }),
          { ...context, credential_version: context.credential_version + 1 }); }
        catch { return failure("provider_rejected", "credential_seal_failure"); }
        const commit = { action: "commit", connection_id: connection, attempt_id: attempt, credential_envelope: envelope, expires_at: new Date(expires).toISOString() };
        // Only retry this exact ciphertext commit, which is CAS + receipt-backed.
        for (let tries=0; tries<2; tries++) {
          try { const result = await rpc(commit); if (result.status === "committed") return { status: "committed" }; }
          catch { /* a lost commit reply is recovered through its original digest */ }
        }
        return { status: "uncertain" };
    },
  });
}
