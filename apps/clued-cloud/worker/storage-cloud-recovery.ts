import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveCreatePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-postcondition.mjs";
import { createGoogleDriveModifyPostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-modify-postcondition.mjs";
import { createGoogleDriveReplacePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-replace-postcondition.mjs";
import { createGoogleDriveDestructivePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-destructive-postcondition.mjs";
import { DESTRUCTIVE_PROOF_CONTRACTS } from "../../../kernel/host/resource-center-google-drive-destructive-effect.mjs";
import { createGoogleDriveDirectoryMovePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-directory-move-postcondition.mjs";
import { createGoogleDriveCreateAbsenceProbe } from "../../../kernel/host/resource-center-google-drive-absence.mjs";
import { observeGoogleDriveSemanticAttempt } from "../../../kernel/host/resource-center-google-drive-semantic-recovery.mjs";
import { createStorageCredentialVault, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageFetch } from "./storage-fetch";
import { scopeProfile } from "./storage-google-scopes";
import { recoveryDiagnostic, type RecoveryDiagnostic, type RecoveryStage } from "./storage-recovery-diagnostics";
import { createStorageRecoveryReview } from "./storage-recovery-review";
import { createStorageCurrentRegistrationRecovery } from "./storage-registration-recovery";
import { createStorageCurrentLocationRecovery } from "./storage-location-recovery";

type Data = Record<string, unknown>;
type Reference = { connection_id: string; job_id: string };
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const providerId = /^[A-Za-z0-9_-]{1,160}$/;
const denied = () => new Error("storage_recovery_unavailable");
const EXPIRING = "storage_recovery_credential_expiring";

/** Internal refresh receiver only. The database independently rechecks this
 * original job and current reader before its single token exchange. */
export function storageRecoveryRefreshReference(descriptor: Data, original: Reference): Reference {
  if (descriptor.status !== "recovery_only" || descriptor.connection_id !== original.connection_id ||
      descriptor.job_id !== original.job_id || !uuid.test(original.connection_id) || !uuid.test(original.job_id)) throw denied();
  const reader = descriptor.recovery_reader;
  if (reader === undefined) return { ...original };
  if (!object(reader) || reader.contract !== "clued.storage-recovery-reader/1" ||
      !uuid.test(String(reader.connection_id)) || reader.credential_version !== descriptor.credential_version) throw denied();
  return { connection_id: String(reader.connection_id), job_id: original.job_id };
}

/** Private settlement-only composition. The trusted RPC must independently
 * authenticate and pin the original job, intent and provider attempt on BOTH
 * calls. This is not an authorization surface and never substitutes for that
 * database contract. No executor, token refresh, retry or normal-load fallback
 * exists here. A missing/expired credential requires a separate human recovery;
 * with `report_expiring` an expiring one is reported as credential_expiring
 * before any Drive read, so scheduled recovery may run the recovery-only refresh
 * bound to this job (BUG-20261007-005).
 * With `absent`, a create whose effect Drive proves absent (no file with the
 * generated ID, none tagged with the intent) is settled as not effected by the
 * database, which decides whether the create could still run.
 */
export async function createStorageCloudRecovery(config: {
  client_id: string; vault: Parameters<typeof createStorageCredentialVault>[0];
  rpc: (input: Data) => Promise<Data>; fetch?: typeof fetch; clock?: () => number;
  timeout_ms?: number;
  verified?: { descriptor: Data; rpc: (input: Data) => Promise<Data> };
  absent?: { rpc: (input: Data) => Promise<Data> };
  current_registration?: { rpc: (input: Data) => Promise<Data> };
  /** Report an expiring credential as credential_expiring instead of inspection_required. */
  report_expiring?: boolean;
  /** Same-job diagnostic persistence only; never dispatches a storage effect. */
  report_diagnostic?: (reference: Reference, diagnostic: RecoveryDiagnostic) => Promise<void>;
}) {
  const timeout = config.timeout_ms ?? 10000;
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id) || typeof config.rpc !== "function" ||
      !Number.isInteger(timeout) || timeout < 1 || timeout > 60000 ||
      (config.absent !== undefined && (!config.verified || typeof config.absent?.rpc !== "function")) ||
      (config.report_diagnostic !== undefined && typeof config.report_diagnostic !== "function") ||
      (config.current_registration !== undefined && (!config.verified || typeof config.current_registration.rpc !== "function"))) throw denied();
  const vault = await createStorageCredentialVault(config.vault);
  const fetcher = createStorageFetch(config.fetch);
  const clock = config.clock ?? Date.now;
  const runOriginal = async (reference: Reference) => {
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
    let stage: RecoveryStage = "descriptor";
    const failure = async (error: unknown, expiring = false) => {
      if (!config.report_diagnostic) return { status: expiring ? "credential_expiring" : "inspection_required", execution_permitted: false };
      const diagnostic = recoveryDiagnostic(stage, error, clock(), abort.signal.aborted && ["provider", "verification"].includes(stage));
      // A lost diagnostic write does not replace the original failure, prove
      // settlement or permit another provider effect. Owner inspect reads the
      // original journal; a later scheduled run continues the same job.
      let reportTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([config.report_diagnostic(pinned, diagnostic), new Promise<never>((_, reject) => {
          reportTimer = setTimeout(() => reject(denied()), Math.min(timeout, 10000));
        })]);
      } catch { /* Preserve the original closed diagnostic. */ }
      finally { clearTimeout(reportTimer); }
      return { status: expiring ? "credential_expiring" : "inspection_required", job_id: pinned.job_id,
        execution_permitted: false, diagnostic };
    };
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
      const reader = d.recovery_reader;
      if (reader !== undefined && (!config.verified || !object(reader) || reader.contract !== "clued.storage-recovery-reader/1" ||
          !uuid.test(String(reader.connection_id)) || reader.credential_version !== d.credential_version ||
          Object.keys(reader).sort().join(",") !== "auth_generation,connection_id,connection_version,contract,credential_version,policy_generation,policy_id,profile_version,scope_digest" ||
          !uuid.test(String(reader.policy_id)) || !/^[0-9a-f]{64}$/.test(String(reader.scope_digest)) ||
          [reader.auth_generation, reader.connection_version, reader.policy_generation, reader.profile_version].some(value => !Number.isSafeInteger(value) || Number(value) < 1))) throw denied();
      const readContext = object(reader) ? { recovery_reader: reader } : {};
      stage = "credential";
      const credential = async () => {
        check();
        const token: unknown = JSON.parse(await vault.open(d.credential_envelope as StorageCredentialEnvelope, {
          owner_id: String(d.owner_id), connection_id: object(reader) ? String(reader.connection_id) : pinned.connection_id, provider: "google-drive",
          provider_subject: String(d.provider_subject), oauth_client_id: config.client_id,
          credential_version: Number(d.credential_version),
        })); check();
        if (!object(token) || token.token_type !== "Bearer" || typeof token.access_token !== "string" ||
            token.access_token.length < 16 || scopeProfile(token.scope) === null ||
            !Number.isFinite(token.expires_at_ms) || !Number.isFinite(clock())) throw denied();
        // A recovery read has the same freshness floor as normal metadata
        // reads. Recheck before every GET, including quarantined jobs.
        if (Number(token.expires_at_ms) - clock() < Math.max(60000, timeout + 1000)) throw new Error(EXPIRING);
        return { access_token: token.access_token, scope: token.scope };
      };
      // An expiring credential is reported before any Drive read.
      try { await credential(); }
      catch (error) {
        if (config.report_expiring && error instanceof Error && error.message === EXPIRING)
          return await failure(error, true);
        throw error;
      }
      // The one GET-only Drive metadata channel, shared by verification and the absence probe.
      const metadataFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        check();
        const url = new URL(String(input));
        if (init?.method !== "GET" || init.body != null || url.origin !== "https://www.googleapis.com" ||
            url.username || url.password || url.hash ||
            !/^\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+(?:\/revisions\/[A-Za-z0-9_-]+)?)?$/.test(url.pathname) ||
            [...url.searchParams.keys()].some(key => !["fields", "supportsAllDrives", "includeItemsFromAllDrives", "q", "pageSize", "pageToken"].includes(key))) throw denied();
        return bounded(fetcher(input, { ...init, signal: AbortSignal.any([abort.signal, ...(init.signal ? [init.signal] : [])]) }));
      };
      // Storage step 1 (Task ce5c725e): a rate-limited or failed read is retried twice
      // with backoff inside the budget instead of waiting for the next listing.
      const metadata = createGoogleDriveMetadataApi({ get_credential: credential, fetch: metadataFetch, transient_retries: 2,
        semantic_details: d.semantic_recovery !== undefined });
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
      let semanticObservation: Data | undefined;
      if (d.semantic_recovery !== undefined) {
        if (!config.verified || subtree || !object(d.semantic_recovery)) throw denied();
        stage = "verification";
        const semantic = await bounded(observeGoogleDriveSemanticAttempt({
          semantic: d.semantic_recovery, oauth_client_id: config.client_id, mutation: d.mutation,
          provider_attempt: d.attempt, provider_before: d.provider_before, profile: d.profile,
          root_folder_id: d.root_folder_id, root_parent_id: d.root_parent_id,
          get_file: metadata.getFile, list_children: metadata.listChildren, clock,
          timeout_ms: Math.min(timeout, 30000), signal: abort.signal,
        })); check();
        semanticObservation = semantic.proof;
        if (semantic.outcome === "deferred") throw new Error("DRIVE_POSTCONDITION_SYNC_TIMEOUT");
        if (semantic.outcome !== "after") {
          let absenceProof: unknown, revisionObservation: unknown;
          if (semantic.outcome === "absence_probe_required") {
            absenceProof = await bounded(createGoogleDriveCreateAbsenceProbe({ get_credential: credential,
              fetch: (input: RequestInfo | URL, init?: RequestInit) => metadataFetch(input, init) })(
              { provider_file_id: String(d.attempt.provider_file_id), parent_id: String(d.attempt.parent_id), intent_id: String(d.intent_id) },
              { signal: abort.signal }));check();
            if (!absenceProof) throw denied();
          }
          if (replace && semantic.outcome === "before") {
            const revision = await bounded(metadata.getRevision(String(d.attempt.provider_file_id), String(d.attempt.pinned_revision_id), { signal: abort.signal }));check();
            if (!revision) throw denied();
            revisionObservation = { id: revision.id, keepForever: revision.keepForever,
              size: revision.size ?? null, md5Checksum: revision.md5Checksum ?? null };
          }
          stage = "settlement";
          const settled = await bounded(config.verified.rpc({ ...pinned, action: "semantic_settle", intent_id: d.intent_id,
            base_version: d.version, request_sha256: d.request_sha256, credential_version: d.credential_version, ...readContext,
            observation: semanticObservation, ...(absenceProof ? { absence_proof: absenceProof } : {}),
            ...(revisionObservation ? { revision_observation: revisionObservation } : {}) }));check();
          if (!["committed", "resolved", "attention_required"].includes(String(settled.status)) ||
              settled.intent_id !== d.intent_id || settled.connection_id !== pinned.connection_id || settled.job_id !== pinned.job_id ||
              !uuid.test(String(settled.receipt_id)) || settled.execution_permitted !== false ||
              (settled.status === "committed" && settled.state !== "cancelled") ||
              (settled.status === "attention_required" && settled.state !== "conflict") ||
              (settled.status === "resolved" && (!Number.isSafeInteger(settled.base_version) || Number(settled.base_version) < 1 ||
                !uuid.test(String(settled.source_receipt_id)) || settled.source_receipt_id === settled.receipt_id))) throw denied();
          const status = settled.status === "committed" ? "released_not_effected"
            : settled.status === "resolved" ? "resolved" : "attention_required";
          return { status, connection_id: pinned.connection_id, job_id: pinned.job_id, receipt_id: String(settled.receipt_id),
            ...(status === "resolved" ? { resolution: "automatically_reconciled_before", automatic_recovery: "resolved",
              base_version: Number(settled.base_version), source_receipt_id: String(settled.source_receipt_id) } : {}),
            execution_permitted: false };
        }
      }
      // I9 has already fenced this exact replace and released its running slot.
      // Observe before-state first, while the original deadline and read-only
      // credential remain in force; unchanged metadata must not exhaust the
      // after verifier's budget before reconciliation can run.
      if (config.verified && d.conflict_reconcile !== undefined && d.semantic_recovery === undefined) {
        const directoryBefore = destructive && d.mutation.target_kind === "directory";
        if ((!replace && !directoryBefore) || !object(d.conflict_reconcile) || !uuid.test(String(d.conflict_reconcile.source_receipt_id))) throw denied();
        stage = "verification";
        const review = await bounded(createStorageRecoveryReview({ client_id: config.client_id, vault: config.vault,
          descriptor: d, source_receipt_id: String(d.conflict_reconcile.source_receipt_id), clock,
          timeout_ms: Math.min(timeout, 30000), fetch: metadataFetch, rpc: async input => {
            check();
            const result = await bounded(config.rpc(input)); check();
            return result;
          } })); check();
        const reconciled = await bounded(review.reconcile(pinned)); check();
        if (reconciled.status === "resolved" || reconciled.status === "inspection_required") return reconciled;
        if (reconciled.status !== "after_observed") throw denied();
      }
      // BUG-20261008-002: a create that may be proven absent polls for its file for half the
      // budget only. Polling for the whole budget left no time for the absence probe and its
      // settlement, so a create whose file never reached Drive stayed started and fenced its root.
      const verifyTimeout = operation === "create" && config.absent ? Math.max(1, Math.floor(timeout / 2)) : timeout;
      const verifierConfig = {
        managed_root: String(d.profile.managed_root), root_folder_id: String(d.root_folder_id), root_parent_id: String(d.root_parent_id),
        get_file: (id: string) => metadata.getFile(id, { signal: abort.signal }),
        list_children: (input: Data) => metadata.listChildren(input, { signal: abort.signal }),
        include_verified_proof: !!config.verified, timeout_ms: verifyTimeout, poll_ms: Math.min(1000, verifyTimeout), clock,
      };
      // The descendant refresh (P6.1) reads a few at a time and stops
      // starting reads after a fraction of the budget, leaving the rest of it
      // for recording and settling the proof; what is not read keeps its
      // registered version.
      const verify = subtree ? createGoogleDriveDirectoryMovePostconditionVerifier({ ...verifierConfig,
          refresh_ms: Math.max(1, Math.floor(timeout / 4)),
          get_sharing: (id: string) => metadata.getSharing(id, { signal: abort.signal }),
          get_access: (id: string) => metadata.getAccess(id, { signal: abort.signal }) })
        : destructive ? createGoogleDriveDestructivePostconditionVerifier({ ...verifierConfig,
          has_children: (id: string) => metadata.hasChildren(id, { signal: abort.signal }) })
        : replace
        ? createGoogleDriveReplacePostconditionVerifier({ ...verifierConfig,
          get_revision: (fileId: string, revisionId: string) => metadata.getRevision(fileId, revisionId, { signal: abort.signal }) })
        : modify ? createGoogleDriveModifyPostconditionVerifier(verifierConfig)
        : createGoogleDriveCreatePostconditionVerifier({ ...verifierConfig, require_effect_provider_id: true,
          get_sharing: (id: string) => metadata.getSharing(id, { signal: abort.signal }),
          get_access: (id: string) => metadata.getVersionedAccess(id, { signal: abort.signal }) });
      stage = "verification";
      const verification = bounded(verify({ profile: d.profile, mutation: d.mutation, provider_before: d.provider_before,
        effect_result: subtree
          ? { operation, target_kind: "directory", source_path: d.mutation.source_path, destination_path: d.mutation.destination_path,
              provider_file_id: d.attempt.provider_file_id, subtree_sample: d.attempt.subtree_sample, descendants: d.attempt.descendants }
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
      let postcondition: unknown;
      try { postcondition = await verification; }
      catch (error) {
        // BUG-20261007-005: a create whose effect cannot be proven may be proven absent.
        if (!config.absent || !config.verified || operation !== "create") throw error;
        check();
        const proof = await bounded(createGoogleDriveCreateAbsenceProbe({ get_credential: credential,
          fetch: (input: RequestInfo | URL, init?: RequestInit) => metadataFetch(input, init) })(
          { provider_file_id: String(d.attempt.provider_file_id), parent_id: String(d.attempt.parent_id), intent_id: String(d.intent_id) },
          { signal: abort.signal })); check();
        if (!proof) throw error;
        stage = "settlement";
        const settled = await bounded(config.absent.rpc({ action: "settle_absent", ...pinned, intent_id: d.intent_id,
          base_version: d.version, request_sha256: d.request_sha256, proof,
          ...(object(reader) ? { credential_version: d.credential_version, ...readContext } : {}) })); check();
        if (settled.status === "resolved" && settled.state === "conflict" &&
            settled.resolution === "automatically_reconciled_before" && settled.automatic_recovery === "resolved" &&
            settled.intent_id === d.intent_id && settled.connection_id === pinned.connection_id && settled.job_id === pinned.job_id &&
            settled.base_version === d.version && uuid.test(String(settled.receipt_id)) && settled.execution_permitted === false &&
            object(reader) && object(d.conflict_absence) && d.conflict_absence.closed_version === d.version &&
            uuid.test(String(d.conflict_absence.source_receipt_id)) && settled.source_receipt_id === d.conflict_absence.source_receipt_id &&
            settled.receipt_id !== settled.source_receipt_id) {
          return { status: "resolved", connection_id: pinned.connection_id, job_id: pinned.job_id,
            intent_id: d.intent_id, receipt_id: String(settled.receipt_id),
            source_receipt_id: String(settled.source_receipt_id), base_version: d.version,
            resolution: "automatically_reconciled_before", automatic_recovery: "resolved", execution_permitted: false };
        }
        if (settled.status !== "committed" || settled.state !== "cancelled" || settled.intent_id !== d.intent_id ||
            settled.connection_id !== pinned.connection_id || settled.job_id !== pinned.job_id ||
            !uuid.test(String(settled.receipt_id)) || settled.execution_permitted !== false) throw denied();
        return { status: "released_not_effected", job_id: pinned.job_id, receipt_id: String(settled.receipt_id), execution_permitted: false };
      }
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
        if (semanticObservation && (!object(semanticObservation.second) ||
          semanticObservation.second.provider_file_version !== proof.provider_file_version)) throw denied();
        const finish = { action: "finalize", intent_id: d.intent_id, base_version: d.version,
          request_sha256: d.request_sha256, idempotency_key: `account-job:${pinned.job_id}:finalize`, postcondition: post };
        stage = "verified_record";
        const recorded = await bounded(config.verified.rpc({ ...pinned, action: "verified_record",
          credential_version: d.credential_version, finish, proof, ...readContext,
          ...(semanticObservation ? { semantic_observation: semanticObservation } : {}) })); check();
        if (recorded.status !== "verified" || recorded.intent_id !== d.intent_id ||
          recorded.version !== d.version || !uuid.test(String(recorded.verified_receipt_id)) ||
          !/^[0-9a-f]{64}$/.test(String(recorded.verified_digest)) || recorded.execution_permitted !== false) throw denied();
        stage = "settlement";
        done = await bounded(config.verified.rpc({ ...pinned, action: "settle_verified", intent_id: d.intent_id,
          base_version: d.version, request_sha256: d.request_sha256,
          verified_receipt_id: recorded.verified_receipt_id, verified_digest: recorded.verified_digest }));
      } else {
        stage = "settlement";
        done = await bounded(config.rpc({ ...pinned, action: "recovery_finalize", credential_version: d.credential_version,
          recovery_binding: d.recovery_binding,
          finish: { intent_id: d.intent_id, base_version: d.version, request_sha256: d.request_sha256, postcondition } }));
      }
      check();
      if (done.status !== "committed" || done.state !== "committed" || done.intent_id !== d.intent_id ||
          !uuid.test(String(done.receipt_id)) || done.execution_permitted !== false ||
          (config.verified && (!object(done.final_result) || done.final_result.status !== "committed"))) throw denied();
      return { status: "committed", job_id: pinned.job_id, receipt_id: String(done.receipt_id), execution_permitted: false };
    } catch (error) {
      // Includes an unknown finalize reply: query the original job separately;
      // never treat failure/timeout as permission to repeat its provider effect.
      return await failure(error);
    } finally { clearTimeout(timer); abort.abort(); }
  };
  const registration = config.current_registration ? await createStorageCurrentRegistrationRecovery({ client_id: config.client_id,
    vault: config.vault, rpc: config.current_registration.rpc, fetch: config.fetch, clock }) : null;
  const location = config.current_registration ? await createStorageCurrentLocationRecovery({client_id:config.client_id,
    vault:config.vault,rpc:config.current_registration.rpc,fetch:config.fetch,clock,timeout_ms:Math.min(timeout,30000)}) : null;
  return Object.freeze({ async run(reference: Reference) {
    const result = await runOriginal(reference);
    const d = config.verified?.descriptor;
    if (!registration || !d || !object(d.mutation) || !object(d.attempt) || !uuid.test(String(d.intent_id)) ||
        d.connection_id !== reference?.connection_id || d.job_id !== reference?.job_id ||
        !((d.mutation.target_kind === "directory" && ["delete", "restore"].includes(String(d.mutation.operation)) &&
            d.attempt.contract === "clued.storage-destructive-attempt/1") ||
          (["file", "directory"].includes(String(d.mutation.target_kind)) && d.mutation.operation === "create" &&
            d.attempt.contract === "clued.resource-center-provider-attempt/1")) ||
        !["inspection_required", "attention_required", "credential_expiring"].includes(String(result.status))) return result;
    try { return await registration.run(reference, String(d.intent_id)); }
    catch (error) {
      // Original result/diagnostic stays authoritative after a denied current
      // qualification. This never manufactures success or a provider retry.
      if (error instanceof Error && error.message === EXPIRING) return { ...result, status: "credential_expiring" };
      if (location && d.mutation.target_kind === "directory" && ["delete","restore"].includes(String(d.mutation.operation)) &&
          d.attempt.contract === "clued.storage-destructive-attempt/1") {
        try { return await location.run(reference,String(d.intent_id)); }
        catch (locationError) {
          if (locationError instanceof Error && locationError.message === EXPIRING) return {...result,status:"credential_expiring"};
        }
      }
      return result;
    }
  }});
}
