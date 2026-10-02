import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveCreatePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-postcondition.mjs";
import { createGoogleDriveModifyPostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-modify-postcondition.mjs";
import { createGoogleDriveReplacePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-replace-postcondition.mjs";
import { createGoogleDriveDestructivePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-destructive-postcondition.mjs";
import { DESTRUCTIVE_PROOF_CONTRACTS } from "../../../kernel/host/resource-center-google-drive-destructive-effect.mjs";
import { createGoogleDriveDirectoryMovePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-directory-move-postcondition.mjs";
import { createStorageCredentialVault, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageFetch } from "./storage-fetch";
import { scopeProfile } from "./storage-google-scopes";

type Data = Record<string, unknown>;
type Reference = { connection_id: string; job_id: string };
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const providerId = /^[A-Za-z0-9_-]{1,160}$/;
const denied = () => new Error("storage_recovery_unavailable");

/** Private settlement-only composition. The trusted RPC must independently
 * authenticate and pin the original job, intent and provider attempt on BOTH
 * calls. This is not an authorization surface and never substitutes for that
 * database contract. No executor, token refresh, retry or normal-load fallback
 * exists here. A missing/expired credential requires a separate human recovery.
 */
export async function createStorageCloudRecovery(config: {
  client_id: string; vault: Parameters<typeof createStorageCredentialVault>[0];
  rpc: (input: Data) => Promise<Data>; fetch?: typeof fetch; clock?: () => number;
  timeout_ms?: number;
  verified?: { descriptor: Data; rpc: (input: Data) => Promise<Data> };
}) {
  const timeout = config.timeout_ms ?? 10000;
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id) || typeof config.rpc !== "function" ||
      !Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw denied();
  const vault = await createStorageCredentialVault(config.vault);
  const fetcher = createStorageFetch(config.fetch);
  const clock = config.clock ?? Date.now;
  return Object.freeze({ async run(reference: Reference) {
    let pinned: Reference;
    try {
      if (!object(reference) || Object.keys(reference).length !== 2 ||
          typeof reference.connection_id !== "string" || typeof reference.job_id !== "string" ||
          !uuid.test(reference.connection_id) || !uuid.test(reference.job_id)) throw denied();
      pinned = { connection_id: reference.connection_id, job_id: reference.job_id };
    } catch {
      return { status: "inspection_required", execution_permitted: false };
    }
    const abort = new AbortController();
    const expired = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(denied()), { once: true });
    });
    // A synchronous adapter failure can happen before the first race attaches.
    // Mark the original promise handled without replacing its rejecting value.
    void expired.catch(() => {});
    const timer = setTimeout(() => abort.abort(), timeout);
    const check = () => abort.signal.throwIfAborted();
    // Race even a misbehaving private adapter that ignores AbortSignal. A late
    // load/provider response must never proceed to settlement after the deadline.
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired]);
    try {
      const loaded = config.verified?.descriptor ?? await bounded(config.rpc({ ...pinned, action: "recovery_load" })); check();
      const d = structuredClone(loaded);
      if (d.status !== "recovery_only" || d.connection_id !== pinned.connection_id || d.job_id !== pinned.job_id ||
          !uuid.test(String(d.owner_id)) || !uuid.test(String(d.intent_id)) || d.provider !== "google-drive" ||
          d.oauth_client_id !== config.client_id || typeof d.provider_subject !== "string" ||
          !/^[A-Za-z0-9_-]{1,255}$/.test(d.provider_subject) || !Number.isSafeInteger(d.credential_version) ||
          Number(d.credential_version) < 1 || !Number.isSafeInteger(d.version) || Number(d.version) < 1 ||
          (!config.verified && !/^[0-9a-f]{64}$/.test(String(d.recovery_binding))) ||
          !/^[0-9a-f]{64}$/.test(String(d.request_sha256)) || !providerId.test(String(d.root_folder_id)) ||
          !providerId.test(String(d.root_parent_id)) || !object(d.profile) || !object(d.mutation) ||
          !object(d.provider_before) || !object(d.attempt) ||
          !providerId.test(String(d.attempt.provider_file_id)) ||
          (d.attempt.destination_path ?? null) !== (d.mutation.destination_path ?? null) ||
          // Trash and in-place untrash (P5) have no destination: the attempt names the source's folder.
          d.attempt.parent_id !== (d.provider_before.destination_parent_id ??
            (d.mutation.operation === "delete" || d.mutation.operation === "restore" ? d.provider_before.source_parent_id : undefined))) throw denied();
      const credential = async () => {
        check();
        const token: unknown = JSON.parse(await vault.open(d.credential_envelope as StorageCredentialEnvelope, {
          owner_id: String(d.owner_id), connection_id: pinned.connection_id, provider: "google-drive",
          provider_subject: String(d.provider_subject), oauth_client_id: config.client_id,
          credential_version: Number(d.credential_version),
        })); check();
        if (!object(token) || token.token_type !== "Bearer" || typeof token.access_token !== "string" ||
            token.access_token.length < 16 || scopeProfile(token.scope) === null ||
            !Number.isFinite(token.expires_at_ms) || !Number.isFinite(clock()) ||
            Number(token.expires_at_ms) - clock() <= timeout + 1000) throw denied();
        return { access_token: token.access_token, scope: token.scope };
      };
      const metadata = createGoogleDriveMetadataApi({ get_credential: credential, fetch: async (input, init) => {
        check();
        const url = new URL(String(input));
        if (init?.method !== "GET" || init.body != null || url.origin !== "https://www.googleapis.com" ||
            url.username || url.password || url.hash ||
            !/^\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+(?:\/revisions\/[A-Za-z0-9_-]+)?)?$/.test(url.pathname) ||
            [...url.searchParams.keys()].some(key => !["fields", "supportsAllDrives", "includeItemsFromAllDrives", "q", "pageSize", "pageToken"].includes(key))) throw denied();
        return bounded(fetcher(input, { ...init, signal: AbortSignal.any([abort.signal, ...(init.signal ? [init.signal] : [])]) }));
      }});
      // Rename and file move (P3) settle only through the verified record.
      const operation = String(d.mutation.operation);
      // A directory move (P6) settles only through the verified record, and
      // only by the Owner's native recovery: scheduled recovery never loads it.
      const subtree = operation === "move" && d.mutation.target_kind === "directory";
      const modify = !subtree && (operation === "rename" || operation === "move");
      const replace = operation === "replace";
      const destructive = operation === "delete" || operation === "restore";
      if (destructive && (!config.verified || d.attempt.contract !== "clued.storage-destructive-attempt/1" ||
          d.attempt.operation !== operation || d.attempt.source_path !== d.mutation.source_path)) throw denied();
      if (subtree && (!config.verified || d.attempt.contract !== "clued.storage-subtree-move-attempt/1" ||
          d.attempt.operation !== "move" || d.attempt.target_kind !== "directory" ||
          d.attempt.source_path !== d.mutation.source_path)) throw denied();
      if (modify && (!config.verified || d.attempt.contract !== "clued.storage-modify-attempt/1" ||
          d.attempt.operation !== operation || d.attempt.source_path !== d.mutation.source_path)) throw denied();
      if (replace && (!config.verified || d.attempt.contract !== "clued.storage-replace-attempt/1" ||
          d.attempt.operation !== "replace")) throw denied();
      if ("content_ref" in d.mutation && !config.verified) throw denied();
      const verifierConfig = {
        managed_root: String(d.profile.managed_root), root_folder_id: String(d.root_folder_id), root_parent_id: String(d.root_parent_id),
        get_file: (id: string) => metadata.getFile(id, { signal: abort.signal }),
        list_children: (input: Data) => metadata.listChildren(input, { signal: abort.signal }),
        include_verified_proof: !!config.verified, timeout_ms: timeout, poll_ms: Math.min(1000, timeout), clock,
      };
      const verify = subtree ? createGoogleDriveDirectoryMovePostconditionVerifier({ ...verifierConfig,
          get_sharing: (id: string) => metadata.getSharing(id, { signal: abort.signal }),
          get_access: (id: string) => metadata.getAccess(id, { signal: abort.signal }) })
        : destructive ? createGoogleDriveDestructivePostconditionVerifier({ ...verifierConfig,
          has_children: (id: string) => metadata.hasChildren(id, { signal: abort.signal }) })
        : replace
        ? createGoogleDriveReplacePostconditionVerifier({ ...verifierConfig,
          get_revision: (fileId: string, revisionId: string) => metadata.getRevision(fileId, revisionId, { signal: abort.signal }) })
        : modify ? createGoogleDriveModifyPostconditionVerifier(verifierConfig)
        : createGoogleDriveCreatePostconditionVerifier({ ...verifierConfig, require_effect_provider_id: true });
      const postcondition = await bounded(verify({ profile: d.profile, mutation: d.mutation, provider_before: d.provider_before,
        effect_result: subtree
          ? { operation, target_kind: "directory", source_path: d.mutation.source_path, destination_path: d.mutation.destination_path,
              provider_file_id: d.attempt.provider_file_id, subtree_sample: d.attempt.subtree_sample }
          : destructive
          ? { operation, source_path: d.mutation.source_path, destination_path: d.mutation.destination_path ?? null,
              provider_file_id: d.attempt.provider_file_id, content: d.attempt.content }
          : replace
          ? { operation: "replace", destination_path: d.mutation.destination_path, provider_file_id: d.attempt.provider_file_id,
              content_before: d.attempt.content_before, content_after: d.attempt.content_after,
              pinned_revision_id: d.attempt.pinned_revision_id, previously_kept: d.attempt.previously_kept,
              release_revision_ids: d.attempt.release_revision_ids,
              restore_job_id: d.attempt.restore_job_id }
          : modify
          ? { operation, source_path: d.mutation.source_path, destination_path: d.mutation.destination_path,
              provider_file_id: d.attempt.provider_file_id, content: d.attempt.content }
          : { operation: "create", destination_path: d.mutation.destination_path, provider_file_id: d.attempt.provider_file_id } }));
      check();
      let done: Data;
      if (config.verified) {
        const verifiedPost: unknown = postcondition;
        // A binary create (content_ref, StorageNormalUse N3) settles only with the /3 proof.
        const contract = subtree ? "clued.storage-directory-move-verified/1"
          : destructive ? DESTRUCTIVE_PROOF_CONTRACTS[operation as "delete" | "restore"]
          : replace ? "clued.storage-replace-verified/1"
          : modify ? `clued.storage-${operation}-verified/1`
          : object(d.mutation.content_ref) ? "clued.storage-create-verified/3" : "clued.storage-create-verified/2";
        if (!object(verifiedPost) || !object(verifiedPost.verified_proof) ||
            verifiedPost.verified_proof.contract !== contract) throw denied();
        const { verified_proof: proof, ...post } = verifiedPost;
        const finish = { action: "finalize", intent_id: d.intent_id, base_version: d.version,
          request_sha256: d.request_sha256, idempotency_key: `account-job:${pinned.job_id}:finalize`, postcondition: post };
        const recorded = await bounded(config.verified.rpc({ ...pinned, action: "verified_record",
          credential_version: d.credential_version, finish, proof })); check();
        if (recorded.status !== "verified" || recorded.intent_id !== d.intent_id ||
          recorded.version !== d.version || !uuid.test(String(recorded.verified_receipt_id)) ||
          !/^[0-9a-f]{64}$/.test(String(recorded.verified_digest)) || recorded.execution_permitted !== false) throw denied();
        done = await bounded(config.verified.rpc({ ...pinned, action: "settle_verified", intent_id: d.intent_id,
          base_version: d.version, request_sha256: d.request_sha256,
          verified_receipt_id: recorded.verified_receipt_id, verified_digest: recorded.verified_digest }));
      } else {
        done = await bounded(config.rpc({ ...pinned, action: "recovery_finalize", credential_version: d.credential_version,
          recovery_binding: d.recovery_binding,
          finish: { intent_id: d.intent_id, base_version: d.version, request_sha256: d.request_sha256, postcondition } }));
      }
      check();
      if (done.status !== "committed" || done.state !== "committed" || done.intent_id !== d.intent_id ||
          !uuid.test(String(done.receipt_id)) || done.execution_permitted !== false ||
          (config.verified && (!object(done.final_result) || done.final_result.status !== "committed"))) throw denied();
      return { status: "committed", job_id: pinned.job_id, receipt_id: String(done.receipt_id), execution_permitted: false };
    } catch {
      // Includes an unknown finalize reply: query the original job separately;
      // never treat failure/timeout as permission to repeat its provider effect.
      return { status: "inspection_required", execution_permitted: false };
    } finally { clearTimeout(timer); abort.abort(); }
  }});
}
