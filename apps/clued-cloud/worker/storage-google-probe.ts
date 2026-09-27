import { createGoogleDriveDirectoryProbe } from "../../../kernel/host/resource-center-google-drive-qualification.mjs";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createStorageCredentialVault, type StorageCredentialContext, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageFetch } from "./storage-fetch";

type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const scopes = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
function fail(): never { throw new Error("storage_directory_probe_unavailable"); }
type ProbeStage = "request" | "prepare" | "descriptor" | "credential" | "identity" | "directories" | "receipt";
class ProbeFailure extends Error {
  constructor(readonly stage: ProbeStage, readonly reason: string) { super("storage_directory_probe_unavailable"); }
}
// Only fixed codes created here cross the route boundary, never upstream text,
// credentials, descriptors, provider responses or database error details.
const directoryReasons = new Set(["LAYOUT_INVALID", "IDENTITY_INVALID", "PARENT_INVALID", "DIRECTORY_CHANGED",
  "DIRECTORY_NOT_APP_AUTHORIZED", "DIRECTORY_NOT_WRITABLE", "ENUMERATION_INVALID", "PATH_AMBIGUOUS",
  "SHORTCUT_UNQUALIFIED", "DIRECTORY_NOT_LISTED", "ENTRY_LIMIT", "OBSERVATION_EXPIRED", "CLOCK_INVALID"]);
export function storageProbeDiagnostic(error: unknown) {
  return error instanceof ProbeFailure ? { stage: error.stage, reason: error.reason } : { stage: "request", reason: "UNCONFIRMED" };
}

/** Private server composition. rpc preserves the native Owner JWT AND adds the
 * fixed server issuer. Only the connection ID is public input. This is a GET-only
 * observation with a post-read CAS receipt, never a writer qualification/grant.
 */
export async function createStorageGoogleProbe(config: {
  client_id: string; vault: Parameters<typeof createStorageCredentialVault>[0];
  rpc: (input: Data) => Promise<Data>; fetch?: typeof fetch; clock?: () => number;
}) {
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id) || typeof config.rpc !== "function") fail();
  const vault = await createStorageCredentialVault(config.vault);
  const fetcher = createStorageFetch(config.fetch), clock = config.clock ?? Date.now;
  return Object.freeze({ async run(input: unknown) {
    let stage: ProbeStage = "request";
    try {
      if (!object(input) || Object.keys(input).length !== 1 || typeof input.connection_id !== "string" || !uuid.test(input.connection_id)) fail();
      stage = "prepare";
      const prepared = await config.rpc({ action: "prepare", connection_id: input.connection_id });
      stage = "descriptor";
      const d = prepared.descriptor;
      if (prepared.status !== "prepared" || !uuid.test(String(prepared.attempt_id)) || !object(d) ||
        !uuid.test(String(d.owner_id)) || d.connection_id !== input.connection_id || d.oauth_client_id !== config.client_id ||
        typeof d.provider_subject !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(d.provider_subject) ||
        !Number.isSafeInteger(d.credential_version) || Number(d.credential_version) < 1) fail();
      const started = clock(), deadline = Math.min(started + 60000, Date.parse(String(prepared.expires_at)) - 5000);
      if (!Number.isFinite(started) || !Number.isFinite(deadline) || deadline - started < 1000) fail();
      const context: StorageCredentialContext = { owner_id: String(d.owner_id), connection_id: input.connection_id,
        provider: "google-drive", provider_subject: d.provider_subject, oauth_client_id: config.client_id, credential_version: Number(d.credential_version) };
      stage = "credential";
      const secret: unknown = JSON.parse(await vault.open(prepared.credential_envelope as StorageCredentialEnvelope, context));
      if (!object(secret) || secret.token_type !== "Bearer" || typeof secret.access_token !== "string" || secret.access_token.length < 16 ||
        typeof secret.scope !== "string" || [...new Set(secret.scope.split(/\s+/))].sort().join(" ") !== scopes ||
        !Number.isFinite(secret.expires_at_ms) || Number(secret.expires_at_ms) < deadline + 10000) fail();
      const accessToken = secret.access_token, scope = secret.scope;
      const checkTime = () => { const now = clock(); if (!Number.isFinite(now) || now < started || now >= deadline) fail(); return now; };
      // One budget covers identity lookup, every metadata page, and final reads.
      const signal = AbortSignal.timeout(Math.max(1, Math.floor(deadline-checkTime())));
      const read: typeof fetch = async (url, init) => {
        checkTime(); signal.throwIfAborted();
        const parsed = new URL(String(url));
        if (parsed.origin !== "https://www.googleapis.com" || parsed.username || parsed.password || parsed.hash ||
          !/^\/drive\/v3\/(about|files(?:\/[A-Za-z0-9_-]+)?)$/.test(parsed.pathname) || parsed.searchParams.has("alt") ||
          init?.method !== "GET") fail();
        const result = await fetcher(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
        checkTime(); signal.throwIfAborted(); return result;
      };
      stage = "identity";
      const about = await read("https://www.googleapis.com/drive/v3/about?fields=user(permissionId,me)", {
        method: "GET", cache: "no-store", headers: { authorization: "Bearer " + accessToken }, signal: AbortSignal.timeout(10000),
      });
      if (!about.ok) fail();
      const identity: unknown = await about.json();
      if (!object(identity) || !object(identity.user) || identity.user.me !== true || identity.user.permissionId !== d.provider_subject) fail();
      stage = "directories";
      const metadata = createGoogleDriveMetadataApi({ get_credential: async () => ({access_token:accessToken,scope}),
        fetch: read, authorization_details: true, timeout_ms: 10000 });
      const observation = await createGoogleDriveDirectoryProbe({ trusted_layout: d.layout,
        get_file: metadata.getFile, list_folder: metadata.listFolder, clock,
        timeout_ms: Math.max(1, Math.floor(deadline-checkTime())) })();
      checkTime(); signal.throwIfAborted();
      stage = "receipt";
      const result = await config.rpc({ action: "complete", attempt_id: prepared.attempt_id, observation });
      if (result.status !== "metadata_observed" || result.attempt_id !== prepared.attempt_id ||
        !uuid.test(String(result.receipt_id)) || result.execution_permitted !== false) fail();
      // Never spread an RPC/provider response onto the public boundary.
      return { status: "metadata_observed", attempt_id: String(prepared.attempt_id), receipt_id: String(result.receipt_id), execution_permitted: false };
    } catch (error) {
      const candidate = error instanceof Error && error.message.startsWith("DRIVE_QUALIFICATION_")
        ? error.message.slice("DRIVE_QUALIFICATION_".length) : "";
      throw new ProbeFailure(stage, stage === "directories" && directoryReasons.has(candidate) ? candidate : "UNCONFIRMED");
    }
  }});
}
