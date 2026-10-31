/**
 * Storage step 2 (StorageFineGrainedConcurrency.v0.1 §4.1, Task e2eb07d1):
 * registered directories that have neither a sharing nor an access digest get
 * their access digest, one directory at a time.
 *
 * Every minute this run asks `clued_storage_access_digest_backfill_v1` for up
 * to five such directories under quiet, undenied roots. For each it loads the
 * connection's credential, reads the folder's version and permissions in one
 * Drive request, and commits the outcome. The database stores the digest only
 * when that version is the registered one and the row is unchanged.
 *
 * Bug 38bb5ddf (Decision 24422a98): as in Drive, a folder's permissions are
 * inherited from its parent and its version moves whenever anything inside it
 * changes. When the version moved, a folder only its owner can reach is
 * recorded as is (nothing is narrower; this also covers the root); otherwise
 * this run reads the registered parent the database names, and the database
 * records the folder's digest when it equals the parent's current access
 * digest and the parent itself is unchanged. A 404, no usable permission
 * list, no parent baseline or a real difference from the parent marks the
 * directory missing with that reason, and the database keeps trying it with
 * backoff; only a real sharing difference, or a folder still gone or
 * unreadable after many attempts, is shown to the Owner. A transient or
 * credential failure commits nothing and the directory waits behind the
 * others. Read only: no Drive write. Enabled renewal uses current Native
 * artifact authorization before refreshing an expiring credential.
 */
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { googleDriveAccessDigest, googleDriveSharingDigest } from "../../../kernel/host/resource-center-google-drive-sharing.mjs";
import { resolveSupabasePublicConfig } from "../app/supabase-public-config";
import { createStorageCredentialVault, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageFetch } from "./storage-fetch";
import { scopeProfile } from "./storage-google-scopes";
import { databaseGatewayToken, type DatabaseGatewayEnv } from "./database-gateway";
import { createStorageDemandRuntime } from "./storage-demand-runtime";

export interface StorageAccessDigestBackfillEnv extends DatabaseGatewayEnv {
  CLUED_STORAGE_ACCOUNT_V1?: string;
  CLUED_STORAGE_GOOGLE_V1?: string;
  CLUED_STORAGE_JOBS_V2?: string;
  CLUED_STORAGE_EXECUTOR_V1?: string;
  CLUED_STORAGE_CONNECTOR_ISSUER?: string;
  CLUED_STORAGE_GOOGLE_CLIENT_ID?: string;
  CLUED_STORAGE_GOOGLE_CLIENT_SECRET?: string;
  CLUED_STORAGE_REFRESH_V1?: string;
  CLUED_STORAGE_VAULT_KEYS?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

export type StorageAccessDigestBackfillResult =
  | { status: "disabled" | "unavailable" }
  | { status: "ok"; recorded: number; missing: number; skipped: number };

type Data = Record<string, unknown>;
type Reference = { connection_id: string; artifact_id: string };
type Parent = { artifact_id: string; provider_file_id: string; row_version: number; mode: "access" | "sharing" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,160}$/;
const VERSION = /^[0-9]{1,40}$/;
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const parentOf = (value: unknown): Parent | null | undefined => {
  if (value === null || value === undefined) return null;
  if (!object(value) || Object.keys(value).sort().join(",") !== "artifact_id,mode,provider_file_id,row_version" ||
      !UUID.test(String(value.artifact_id)) || !PROVIDER_ID.test(String(value.provider_file_id)) ||
      !Number.isSafeInteger(value.row_version) || !["access", "sharing"].includes(String(value.mode))) return undefined;
  return value as Parent;
};

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function runStorageAccessDigestBackfillScheduled(env: StorageAccessDigestBackfillEnv,
  deps: { fetch?: typeof fetch; clock?: () => number } = {}): Promise<StorageAccessDigestBackfillResult> {
  if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_GOOGLE_V1 !== "true" ||
      env.CLUED_STORAGE_JOBS_V2 !== "true" || env.CLUED_STORAGE_EXECUTOR_V1 !== "true") return { status: "disabled" };
  const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
  const gatewayToken = databaseGatewayToken(env);
  const clientId = env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "";
  if (!issuer || issuer.length < 32 || !gatewayToken || !env.CLUED_STORAGE_VAULT_KEYS || !clientId) return { status: "unavailable" };
  const fetcher = deps.fetch ?? fetch;
  const clock = deps.clock ?? Date.now;
  let rpc: (input: Data) => Promise<Data>;
  let refreshRpc: (input: Data) => Promise<Data>;
  let due: Data;
  try {
    const defaults = resolveSupabasePublicConfig({});
    const url = (env.SUPABASE_URL ?? defaults.url).replace(/\/$/, "");
    const key = env.SUPABASE_PUBLISHABLE_KEY ?? defaults.key;
    const issuerHash = await sha256(issuer);
    const native = async (name: string, input: Data) => {
      const response = await fetcher(`${url}/rest/v1/rpc/${name}`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
        headers: { apikey: key, authorization: `Bearer ${gatewayToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: input }),
      });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("storage_access_digest_rpc_failed"); }
      const value: unknown = await response.json();
      if (!object(value)) throw new Error("storage_access_digest_rpc_failed");
      return value;
    };
    rpc = input => native("clued_storage_access_digest_backfill_v1", input);
    refreshRpc = input => native("clued_storage_refresh_worker_v1", input);
    due = await rpc({ action: "due" });
  } catch { return { status: "unavailable" }; }
  const listed = due.directories;
  if (due.status !== "ok" || !Array.isArray(listed) || listed.length > 5 ||
      !listed.every(entry => object(entry) && Object.keys(entry).sort().join(",") === "artifact_id,connection_id" &&
        UUID.test(String(entry.connection_id)) && UUID.test(String(entry.artifact_id)))) return { status: "unavailable" };
  if (listed.length === 0) return { status: "ok", recorded: 0, missing: 0, skipped: 0 };
  let vault: Awaited<ReturnType<typeof createStorageCredentialVault>>;
  try { vault = await createStorageCredentialVault(JSON.parse(env.CLUED_STORAGE_VAULT_KEYS)); }
  catch { return { status: "unavailable" }; }
  let demand: Awaited<ReturnType<typeof createStorageDemandRuntime>> | undefined;
  if (env.CLUED_STORAGE_REFRESH_V1 === "true") try {
    demand = await createStorageDemandRuntime({ client_id: clientId, client_secret: env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET ?? "",
      vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS), fetch: fetcher, clock, refresh_rpc: refreshRpc!,
      prepare: request => refreshRpc!({ action: "prepare_credential", connection_id: request.connection_id,
        caller_kind: "maintenance", request: { operation: "access_digest", artifact_id: request.artifact_id } }) });
  } catch { return { status: "unavailable" }; }
  const driveFetch = createStorageFetch(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method !== "GET" || init.body != null || url.origin !== "https://www.googleapis.com" ||
        !url.pathname.startsWith("/drive/v3/files/") ||
        [...url.searchParams.keys()].some(name => !["fields", "supportsAllDrives"].includes(name))) throw new Error("storage_access_digest_denied");
    return await fetcher(input, init);
  });
  let recorded = 0, missing = 0, skipped = 0;
  for (const entry of listed as Reference[]) {
    const reference = { connection_id: entry.connection_id, artifact_id: entry.artifact_id };
    try {
      if (demand && (await demand.maintenance(reference)).status !== "ready") { skipped++; continue; }
      const d = await rpc({ ...reference, action: "load" });
      if (d.status !== "read_only" || d.connection_id !== reference.connection_id || d.artifact_id !== reference.artifact_id ||
          d.execution_permitted !== false || !UUID.test(String(d.owner_id)) || d.provider !== "google-drive" ||
          d.oauth_client_id !== clientId || !PROVIDER_ID.test(String(d.provider_file_id)) ||
          !VERSION.test(String(d.registered_version)) || !Number.isSafeInteger(d.row_version) ||
          !Number.isSafeInteger(d.credential_version) || !object(d.credential_envelope)) { skipped++; continue; }
      const parent = parentOf(d.parent);
      if (parent === undefined) { skipped++; continue; }
      const token: unknown = JSON.parse(await vault.open(d.credential_envelope as StorageCredentialEnvelope, {
        owner_id: String(d.owner_id), connection_id: reference.connection_id, provider: "google-drive",
        provider_subject: String(d.provider_subject), oauth_client_id: clientId, credential_version: Number(d.credential_version),
      }));
      // Always reload the exact artifact after preflight; it is not a cached
      // admission, and expiry still bounds the ensuing provider read.
      if (!object(token) || token.token_type !== "Bearer" || typeof token.access_token !== "string" ||
          token.access_token.length < 16 || scopeProfile(token.scope) === null ||
          !Number.isFinite(token.expires_at_ms) || Number(token.expires_at_ms) - clock() <= 60000) { skipped++; continue; }
      const accessToken = token.access_token;
      let lastStatus = 0;
      const metadata = createGoogleDriveMetadataApi({
        get_credential: async () => {
          if (Number(token.expires_at_ms) - clock() <= 60000) throw new Error("storage_access_digest_credential_expiring");
          return { access_token: accessToken, scope: token.scope };
        },
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await driveFetch(input, init);
          lastStatus = response.status;
          return response;
        },
        transient_retries: 2,
      });
      // Only an answer about the folder settles it: its version and
      // permissions, or 404 (Drive no longer shows it to this account). A
      // transient or credential failure commits nothing; the directory comes
      // back after the others.
      let found: boolean, observedVersion: string | null = null, digest: string | null = null;
      let parentObservation: Data | undefined, ownerOnly = false;
      try {
        const read = await metadata.getVersionedAccess(String(d.provider_file_id), { signal: AbortSignal.timeout(15000) });
        if (read?.id !== d.provider_file_id || typeof read.version !== "string" || !VERSION.test(read.version)) { skipped++; continue; }
        found = true;
        observedVersion = read.version;
        const computed = googleDriveAccessDigest(read);
        digest = typeof computed === "string" ? computed : null;
        ownerOnly = digest !== null && Array.isArray(read.permissions) && read.permissions.length === 1 &&
          read.permissions[0]?.type === "user" && read.permissions[0]?.role === "owner" && read.permissions[0]?.deleted !== true;
      } catch {
        if (lastStatus !== 404) { skipped++; continue; }
        found = false;
      }
      // The version moved: compare with the parent the registry protects. A
      // parent Drive no longer shows commits without it (no baseline yet).
      if (found && digest && observedVersion !== d.registered_version && parent && !ownerOnly) {
        try {
          const read = await metadata.getVersionedAccess(parent.provider_file_id, { signal: AbortSignal.timeout(15000) });
          if (read?.id !== parent.provider_file_id) { skipped++; continue; }
          const access = googleDriveAccessDigest(read);
          let matched: unknown = access;
          if (parent.mode === "sharing") matched = googleDriveSharingDigest(
            await metadata.getSharing(parent.provider_file_id, { signal: AbortSignal.timeout(15000) }));
          parentObservation = { artifact_id: parent.artifact_id, row_version: parent.row_version,
            observed_digest: typeof matched === "string" ? matched : null, observed_access: typeof access === "string" ? access : null };
        } catch {
          if (lastStatus !== 404) { skipped++; continue; }
        }
      }
      const committed = await rpc({ ...reference, action: "commit", row_version: d.row_version,
        registered_version: d.registered_version, found, observed_version: observedVersion, access_digest: digest,
        ...(parentObservation ? { parent: parentObservation } : {}),
        ...(ownerOnly && observedVersion !== d.registered_version ? { owner_only: true } : {}) });
      if (committed.status !== "committed" || committed.artifact_id !== reference.artifact_id) { skipped++; continue; }
      if (String(committed.outcome).startsWith("recorded")) recorded++; else missing++;
    } catch { skipped++; }
  }
  return { status: "ok", recorded, missing, skipped };
}
