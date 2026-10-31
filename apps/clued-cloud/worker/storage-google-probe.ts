import { createGoogleDriveDirectoryProbe, googleDriveDirectoryDiagnostic, DIRECTORY_DIAGNOSTIC_LIMIT } from "../../../kernel/host/resource-center-google-drive-qualification.mjs";
import { createGoogleDriveBoundaryScanner } from "../../../kernel/host/resource-center-google-drive-boundary.mjs";
import { RESOURCE_CENTER_POLICY_VERSION } from "../../../kernel/policy/resource-center-mutation-policy.mjs";
import { createHash } from "node:crypto";
import { createStorageGoogleMetadataBatch } from "./storage-google-metadata-batch";
import { createStorageCredentialVault, type StorageCredentialContext, type StorageCredentialEnvelope } from "./storage-credential-vault";
import type { StorageDemandResult } from "./storage-demand-refresh";
import { createStorageFetch } from "./storage-fetch";
import { scopeProfile } from "./storage-google-scopes";

type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(): never { throw new Error("storage_directory_probe_unavailable"); }
type ProbeStage = "request" | "prepare" | "descriptor" | "credential" | "identity" | "directories" | "boundary" | "receipt";
// Versioned, deterministic JSON digest for separately retained review Evidence.
// It is not the database's jsonb digest or an execution capability.
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(sortedJson).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + sortedJson(value[key])).join(",") + "}";
  const encoded = JSON.stringify(value); if (encoded === undefined) fail(); return encoded;
}
const digest = (value: unknown) => createHash("sha256").update(sortedJson(value)).digest("hex");
const boundaryReasons = new Set(["PROFILE_UNQUALIFIED", "IDENTITY_INVALID", "ROOT_CHANGED", "ALIAS_OR_CYCLE",
  "FOLDER_INVALID", "CHANGED", "ENUMERATION_INVALID", "ENTRY_LIMIT", "PATH_AMBIGUOUS", "SHORTCUT_UNQUALIFIED",
  "DEPTH_LIMIT", "ROOT_NOT_LISTED"]);
const probeFailures = new WeakMap<Error, Data>();
class ProbeFailure extends Error {
  constructor(stage: ProbeStage, reason: string, directories?: Data) {
    super("storage_directory_probe_unavailable");
    probeFailures.set(this,{stage,reason,...(directories ? {directories} : {})});
  }
}
const objectReasons = new Set(["DIRECTORY_NOT_APP_AUTHORIZED", "DIRECTORY_APP_AUTHORIZATION_UNCONFIRMED",
  "DIRECTORY_NOT_WRITABLE", "DIRECTORY_WRITE_CAPABILITY_UNCONFIRMED"]);
function safeDirectoryDiagnostic(error: unknown, layout: unknown): Data | null {
  const report: unknown = googleDriveDirectoryDiagnostic(error);
  if (!object(report) || !object(layout) || !Array.isArray(layout.directories) ||
    report.contract !== "clued.storage-directory-diagnostic/1" ||
    report.total_directories !== layout.directories.length || report.checked_directories !== report.total_directories ||
    !Number.isSafeInteger(report.total_directories) || Number(report.total_directories)<1 || Number(report.total_directories)>1024 ||
    !Number.isSafeInteger(report.failed_directories) || Number(report.failed_directories)<1 || Number(report.failed_directories)>Number(report.total_directories) ||
    !Array.isArray(report.failures) || report.failures.length!==Math.min(Number(report.failed_directories),DIRECTORY_DIAGNOSTIC_LIMIT) ||
    report.truncated !== (Number(report.failed_directories)>DIRECTORY_DIAGNOSTIC_LIMIT)) return null;
  const seen = new Set<string>(), failures: Data[] = [];
  for (const row of report.failures) {
    if (!object(row) || typeof row.path !== "string" || row.path.length>1000 || /[\u0000-\u001f\u007f]/.test(row.path) ||
      typeof row.provider_file_id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(row.provider_file_id) || seen.has(row.path) ||
      !layout.directories.some(d=>object(d) && d.path===row.path && d.provider_file_id===row.provider_file_id) ||
      !Array.isArray(row.reasons) || row.reasons.length<1 || row.reasons.length>2 || new Set(row.reasons).size!==row.reasons.length ||
      row.reasons.some(reason=>typeof reason!=="string" || !objectReasons.has(reason))) return null;
    seen.add(row.path);failures.push({path:row.path,provider_file_id:row.provider_file_id,reasons:[...row.reasons]});
  }
  return {contract:report.contract,total_directories:report.total_directories,checked_directories:report.checked_directories,
    failed_directories:report.failed_directories,failures,truncated:report.truncated};
}
// Only fixed codes created here cross the route boundary, never upstream text,
// credentials, descriptors, provider responses or database error details.
const directoryReasons = new Set(["LAYOUT_INVALID", "IDENTITY_INVALID", "PARENT_INVALID", "DIRECTORY_CHANGED",
  "DIRECTORY_NOT_APP_AUTHORIZED", "DIRECTORY_NOT_WRITABLE", "ENUMERATION_INVALID", "PATH_AMBIGUOUS",
  "DIRECTORY_APP_AUTHORIZATION_UNCONFIRMED", "DIRECTORY_WRITE_CAPABILITY_UNCONFIRMED",
  "SHORTCUT_UNQUALIFIED", "DIRECTORY_NOT_LISTED", "ENTRY_LIMIT", "OBSERVATION_EXPIRED", "CLOCK_INVALID"]);
const metadataReasons: Readonly<Record<string, string>> = Object.freeze({
  DRIVE_METADATA_MISMATCH: "METADATA_ID_MISMATCH", DRIVE_LIST_INVALID: "ENUMERATION_INVALID",
  DRIVE_PAGINATION_INVALID: "PAGINATION_INVALID", DRIVE_PAGINATION_LIMIT: "PAGINATION_LIMIT",
  DRIVE_ENUMERATION_LIMIT: "ENTRY_LIMIT", DRIVE_NAMESPACE_VISIBILITY_UNPROVEN: "NAMESPACE_VISIBILITY_UNPROVEN",
  DRIVE_BATCH_INVALID: "PROVIDER_RESPONSE_INVALID", DRIVE_BATCH_SIZE_LIMIT: "PROVIDER_RESPONSE_INVALID",
  DRIVE_BATCH_TIMEOUT: "PROVIDER_TIMEOUT", DRIVE_BATCH_HTTP_401: "PROVIDER_AUTHENTICATION_REJECTED",
  DRIVE_BATCH_HTTP_403: "PROVIDER_ACCESS_REJECTED", DRIVE_BATCH_HTTP_404: "PROVIDER_OBJECT_UNAVAILABLE",
  DRIVE_BATCH_HTTP_429: "PROVIDER_RATE_LIMITED", DRIVE_BATCH_HTTP_500: "PROVIDER_SERVER_UNAVAILABLE",
  DRIVE_BATCH_HTTP_400: "PROVIDER_RESPONSE_REJECTED",
});
// Runtime versions may append this fixed configuration hint. Accept the whole
// literal, not arbitrary suffixes: diagnostics must never echo exception text.
const subrequestLimitMessage = /^Too many subrequests(?:\.| by single [Ww]orker invocation\.?)?$/;
const subrequestLimitHint = "Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits";
export function storageProbeDiagnostic(error: unknown) {
  const value = error instanceof Error ? probeFailures.get(error) : undefined;
  return value ? structuredClone(value) : { stage: "request", reason: "UNCONFIRMED" };
}

/** Private server composition. rpc preserves the native Owner JWT AND adds the
 * fixed server issuer. Only the connection ID is public input. This is a metadata-only
 * observation with a post-read CAS receipt, never a writer qualification/grant.
 */
export async function createStorageGoogleProbe(config: {
  client_id: string; vault: Parameters<typeof createStorageCredentialVault>[0];
  rpc: (input: Data) => Promise<Data>; fetch?: typeof fetch; clock?: () => number;
  credential_preflight?: (connectionId: string) => Promise<StorageDemandResult>;
}) {
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id) || typeof config.rpc !== "function") fail();
  const vault = await createStorageCredentialVault(config.vault);
  const fetcher = createStorageFetch(config.fetch), clock = config.clock ?? Date.now;
  return Object.freeze({ async run(input: unknown) {
    let stage: ProbeStage = "request";
    let observationSignal: AbortSignal | undefined, requestSignal: AbortSignal | undefined;
    let trustedLayout: unknown;
    try {
      if (!object(input) || Object.keys(input).length !== 1 || typeof input.connection_id !== "string" || !uuid.test(input.connection_id)) fail();
      stage = "prepare";
      if (config.credential_preflight && (await config.credential_preflight(input.connection_id)).status !== "ready") fail();
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
        scopeProfile(secret.scope) === null ||
        !Number.isFinite(secret.expires_at_ms) || Number(secret.expires_at_ms) < deadline + 10000) fail();
      // Only the exact, vault-authenticated scope set can cover existing files.
      // Caller input and descriptor labels cannot supply this authority.
      const credentialScopeProfile = scopeProfile(secret.scope);
      const accessToken = secret.access_token;
      const checkTime = () => { const now = clock(); if (!Number.isFinite(now) || now < started || now >= deadline) fail(); return now; };
      // One budget covers identity lookup, every metadata page, and final reads.
      const signal = AbortSignal.timeout(Math.max(1, Math.floor(deadline-checkTime())));
      observationSignal = signal;
      const read: typeof fetch = async (url, init) => {
        checkTime(); signal.throwIfAborted();
        const parsed = new URL(String(url));
        if (parsed.origin !== "https://www.googleapis.com" || parsed.username || parsed.password || parsed.hash ||
          !/^\/drive\/v3\/(about|files(?:\/[A-Za-z0-9_-]+)?)$/.test(parsed.pathname) || parsed.searchParams.has("alt") ||
          init?.method !== "GET") fail();
        requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
        const result = await fetcher(url, { ...init, signal: requestSignal });
        // Classify only the numeric status, never Google's body/headers or URL.
        if (!result.ok) {
          const reason = result.status === 401 ? "PROVIDER_AUTHENTICATION_REJECTED"
            : result.status === 403 ? "PROVIDER_ACCESS_REJECTED"
              : result.status === 404 ? "PROVIDER_OBJECT_UNAVAILABLE"
                : result.status === 429 ? "PROVIDER_RATE_LIMITED"
                  : result.status >= 500 ? "PROVIDER_SERVER_UNAVAILABLE" : "PROVIDER_RESPONSE_REJECTED";
          throw new ProbeFailure(stage, reason);
        }
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
      trustedLayout = structuredClone(d.layout);
      // A separate closed transport wraps only metadata GETs in Google's batch
      // endpoint. The identity GET allowlist above is deliberately not widened.
      const metadata = createStorageGoogleMetadataBatch({ access_token: accessToken, fetch: fetcher, signal });
      const observation = await createGoogleDriveDirectoryProbe({ trusted_layout: trustedLayout,
        trusted_scope_profile: credentialScopeProfile,
        get_files: metadata.getFiles, list_folders: metadata.listFolders, get_sharings: metadata.getSharings, clock,
        timeout_ms: Math.max(1, Math.floor(deadline-checkTime())) })();
      checkTime(); signal.throwIfAborted();
      stage = "boundary";
      // Closed to the same Canonical parent/root as the cloud executor. No
      // caller scan roots, external-root exceptions, credential copy or cache.
      // The server-built descriptor names the owner's other active roots under
      // the same parent (Decision b18eff80); the scanner checks their shape.
      if (!object(d.layout) || typeof d.layout.managed_root !== "string") fail();
      const siblingRoots: unknown = d.registered_sibling_roots === undefined ? [] : d.registered_sibling_roots;
      const root = d.layout.managed_root;
      const scanConfig = { managed_root: root, root_folder_id: d.layout.root_folder_id,
        root_parent_id: d.layout.root_parent_id, scan_roots: [{ folder_id: d.layout.root_parent_id,
          path: root.slice(0, root.lastIndexOf("/")) }], registered_sibling_roots: siblingRoots, max_depth: 8, max_entries: 10000 };
      const scan = createGoogleDriveBoundaryScanner({
        trusted_profile: { registration_status: "registered", managed_root: root,
          boundary_scan_max_depth: scanConfig.max_depth, boundary_scan_max_entries: scanConfig.max_entries },
        root_folder_id: scanConfig.root_folder_id, root_parent_id: scanConfig.root_parent_id, scan_roots: scanConfig.scan_roots,
        registered_sibling_roots: scanConfig.registered_sibling_roots, // shape checked by the scanner
        get_file: async (id: string) => { checkTime(); return (await metadata.getFiles([id], { signal }))[0]; },
        list_folder: async (id: string) => { checkTime(); return (await metadata.listFolders([id], { signal }))[0]; },
      });
      const findings = await scan();
      checkTime(); signal.throwIfAborted();
      if (findings.length) throw new ProbeFailure(stage, "UNAUTHORIZED_WORKSPACE_MUTATION");
      // Folders outside the root left undescended at the depth or entry
      // bound (Decision 24422a98) are counted, not hidden behind "clean".
      const unscanned = (findings as { partial?: readonly unknown[] }).partial?.length ?? 0;
      const boundaryObservation = { contract: "clued.storage-boundary-observation/1", status: "clean",
        observed_at_ms: checkTime(), policy_version: RESOURCE_CENTER_POLICY_VERSION,
        scanner_contract: "clued.google-drive-boundary/1", digest_format: "sorted-json/1",
        descriptor_sha256: digest(d), scan_config_sha256: digest(scanConfig), unscanned_branches: unscanned };
      stage = "receipt";
      const result = await config.rpc({ action: "complete", attempt_id: prepared.attempt_id, observation });
      if (result.status !== "metadata_observed" || result.attempt_id !== prepared.attempt_id ||
        !uuid.test(String(result.receipt_id)) || result.execution_permitted !== false) fail();
      // Never spread an RPC/provider response onto the public boundary.
      // This additive report is NOT in the old directory Receipt. Manual
      // qualification must retain immutable Evidence binding this report,
      // attempt/descriptor, exact reviewed release and directory Receipt.
      return { status: "metadata_observed", attempt_id: String(prepared.attempt_id), receipt_id: String(result.receipt_id),
        boundary_observation: boundaryObservation, execution_permitted: false };
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      if (stage === "directories") {
        const directories = safeDirectoryDiagnostic(error,trustedLayout);
        if (directories && Array.isArray(directories.failures) && object(directories.failures[0]) && Array.isArray(directories.failures[0].reasons))
          throw new ProbeFailure(stage,String(directories.failures[0].reasons[0]),directories);
      }
      const candidate = error instanceof Error && error.message.startsWith("DRIVE_QUALIFICATION_")
        ? error.message.slice("DRIVE_QUALIFICATION_".length) : "";
      if (stage === "directories" && directoryReasons.has(candidate)) throw new ProbeFailure(stage, candidate);
      const boundaryCode = error instanceof Error && error.message.startsWith("DRIVE_BOUNDARY_") ? error.message.slice(15) : "";
      if (stage === "boundary" && boundaryReasons.has(boundaryCode)) throw new ProbeFailure(stage, "BOUNDARY_" + boundaryCode);
      if (observationSignal?.aborted) throw new ProbeFailure(stage, "OBSERVATION_EXPIRED");
      // The primitive aborts its callbacks during normal finally cleanup too.
      // Only the private timeout signal's actual reason proves a timeout.
      if (requestSignal?.aborted && requestSignal.reason instanceof DOMException && requestSignal.reason.name === "TimeoutError")
        throw new ProbeFailure(stage, "PROVIDER_TIMEOUT");
      // Exact runtime/adapter literals only. Never copy arbitrary exception text
      // (which may contain a URL or secret), and never turn diagnosis into retry.
      if (stage === "identity" || stage === "directories" || stage === "boundary") {
        if (error instanceof Error && (subrequestLimitMessage.test(error.message) || error.message === subrequestLimitHint))
          throw new ProbeFailure(stage, "RUNTIME_SUBREQUEST_LIMIT");
        if (error instanceof Error && error.message === "storage_redirect_rejected")
          throw new ProbeFailure(stage, "PROVIDER_REDIRECT_REJECTED");
        if (error instanceof SyntaxError) throw new ProbeFailure(stage, "PROVIDER_RESPONSE_INVALID");
        if ((stage === "directories" || stage === "boundary") && error instanceof Error && Object.hasOwn(metadataReasons, error.message))
          throw new ProbeFailure(stage, metadataReasons[error.message]);
      }
      throw new ProbeFailure(stage, "UNCONFIRMED");
    }
  }});
}
