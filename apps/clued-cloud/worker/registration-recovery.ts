type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const version = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,39}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const CONTRACT = "clued.storage-registration-recovery/1";
const same = (a: Data, b: Data) => Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every(key => a[key] === b[key]);

/** Internal cloud composition only. Receives the existing qualified job loader
 * and credential-bound metadata reader, never an Agent-selected Owner or root.
 * A lost commit response inspects the original key; it never resends a commit.
 */
export function createRegistrationRecoveryRpc(config: {
  rpc: (input: Data) => Promise<Data>;
  descriptor: () => Data | null;
  get_file: (id: string) => Promise<Data>;
  clock?: () => number;
  retry_delay?: () => Promise<void>;
  on_recovery?: (result: Data) => void;
}) {
  const attempted = new Set<string>();
  const clock = config.clock ?? Date.now;
  const pause = config.retry_delay ?? (() => new Promise<void>(resolve => setTimeout(resolve, 100)));
  const failure = (original: Data, code: string, state = "unknown") => {
    const recovery = {status: state, reason_code: code, execution_permitted: false};
    config.on_recovery?.(recovery);
    return {...original, status: "denied", reason: original.status === "denied" && typeof original.reason === "string"
      ? original.reason : "destination_version_mismatch", registration_recovery: recovery};
  };
  return async (input: Data): Promise<Data> => {
    const original = await config.rpc(input);
    if (input.action !== "authority") return original;
    const job = config.descriptor(), request = input.request;
    const mismatch = original.status === "denied" && original.reason === "destination_version_mismatch";
    if (!mismatch && (job?.registration_recovery !== true || original.status !== "resolved")) return original;
    if (!job || job.status !== "queued" || !object(job.mutation) || !object(request) || !object(request.provider_identity) ||
        job.mutation.operation !== "replace" || job.mutation.target_kind !== "file" ||
        job.job_id !== input.job_id || job.connection_id !== input.connection_id || job.credential_version !== input.credential_version ||
        !version(job.mutation.destination_file_version) || job.mutation.destination_file_version !== request.provider_identity.destination_file_version ||
        !hash(job.request_digest) || !object(job.profile) || request.profile_id !== job.profile.profile_id) return original;
    const key = String(job.job_id);
    if (attempted.has(key)) return original;
    attempted.add(key);
    const reference = {connection_id: input.connection_id, job_id: input.job_id, credential_version: input.credential_version, request};
    let registration: Data, lease: string;
    try {
      const loaded = await config.rpc({...reference, action: "registration_load"});
      if (loaded.contract !== CONTRACT || loaded.connection_id !== input.connection_id || loaded.job_id !== input.job_id ||
          loaded.execution_permitted !== false) return failure(original, "REGISTRATION_DESCRIPTOR_INVALID");
      // A concurrent qualified job may have completed this exact refresh.
      // Its result is no admission: authority is always resolved again.
      if (loaded.status === "already_current") return await config.rpc(input);
      if (["busy", "failed"].includes(String(loaded.status))) return failure(original,
        typeof loaded.reason_code === "string" ? loaded.reason_code : "REGISTRATION_CHECK_BUSY", String(loaded.status));
      if (!["refreshable", "inspect_required"].includes(String(loaded.status)) || !object(loaded.registration) || !uuid(loaded.lease_id))
        return failure(original, "REGISTRATION_NOT_REFRESHABLE");
      registration = loaded.registration;
      lease = loaded.lease_id;
      if (!uuid(registration.artifact_id) || !uuid(registration.source_decision_id) || !uuid(registration.artifact_receipt_id) ||
          !Number.isSafeInteger(registration.artifact_version) || Number(registration.artifact_version) < 1 ||
          registration.profile_id !== job.profile.profile_id || registration.request_digest !== job.request_digest ||
          registration.credential_version !== job.credential_version || registration.expected_version !== job.mutation.destination_file_version ||
          !version(registration.registered_version) || !version(registration.expected_version) ||
          BigInt(registration.registered_version) >= BigInt(registration.expected_version) ||
          registration.path !== job.mutation.destination_path || registration.root_folder_id !== job.root_folder_id ||
          registration.root_parent_id !== job.root_parent_id || registration.provider_file_id !== request.provider_identity.destination_file_id ||
          registration.parent_provider_id !== request.provider_identity.destination_parent_id ||
          typeof registration.provider_file_id !== "string" || typeof registration.parent_provider_id !== "string")
        return failure(original, "REGISTRATION_DESCRIPTOR_INVALID");
      if (loaded.status === "inspect_required") {
        const inspected = await config.rpc({...reference, action: "registration_inspect", registration, lease_id: lease});
        if (inspected.contract === CONTRACT && inspected.status === "committed" && inspected.connection_id === input.connection_id &&
            inspected.job_id === input.job_id && inspected.artifact_id === registration.artifact_id &&
            inspected.provider_file_version === registration.expected_version && uuid(inspected.receipt_id) &&
            uuid(inspected.registration_receipt_id) && inspected.execution_permitted === false) return await config.rpc(input);
        return failure(original, typeof inspected.reason_code === "string" ? inspected.reason_code : "REGISTRATION_COMMIT_UNKNOWN",
          inspected.status === "retry_wait" || inspected.status === "failed" ? inspected.status : "unknown");
      }
    } catch { return failure(original, "REGISTRATION_LOAD_UNAVAILABLE"); }
    const defer = async (code: string): Promise<Data> => {
      try {
        const result = await config.rpc({...reference, action: "registration_defer", registration, lease_id: lease, reason_code: code});
        if (result.contract === CONTRACT && result.connection_id === input.connection_id && result.job_id === input.job_id &&
            result.execution_permitted === false && ["retry_wait", "commit_unknown", "inspect_required", "failed"].includes(String(result.status)))
          return failure(original, typeof result.reason_code === "string" ? result.reason_code : code, String(result.status));
      } catch { /* A database outage leaves this zero-effect job queued. */ }
      return failure(original, code);
    };
    const observe = async (): Promise<Data> => {
      let metadata: Data | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { metadata = await config.get_file(String(registration.provider_file_id)); break; }
        catch { if (attempt) throw new Error("REGISTRATION_METADATA_UNAVAILABLE"); await pause(); }
      }
      if (!metadata || metadata.id !== registration.provider_file_id || metadata.version !== registration.expected_version ||
          metadata.trashed !== false || !Array.isArray(metadata.parents) || metadata.parents.length !== 1 ||
          metadata.parents[0] !== registration.parent_provider_id || metadata.name !== String(registration.path).split("/").at(-1) ||
          typeof metadata.mimeType !== "string" || metadata.mimeType.startsWith("application/vnd.google-apps.") ||
          !hash(metadata.sha256Checksum) || typeof metadata.size !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(metadata.size) ||
          Number(metadata.size) > 5 * 1024 * 1024) throw new Error("REGISTRATION_METADATA_CHANGED");
      return {id: metadata.id, parent_id: metadata.parents[0], name: metadata.name, mime_type: metadata.mimeType,
        version: metadata.version, trashed: false, size: metadata.size, sha256: metadata.sha256Checksum,
        observed_at: new Date(clock()).toISOString()};
    };
    let first: Data, second: Data;
    try {
      first = await observe(); second = await observe();
      const {observed_at: firstAt, ...firstIdentity} = first, {observed_at: secondAt, ...secondIdentity} = second;
      if (!same(firstIdentity, secondIdentity) || Date.parse(String(secondAt)) < Date.parse(String(firstAt)))
        return await defer("REGISTRATION_METADATA_CHANGED");
    } catch (error) {
      return await defer(error instanceof Error && error.message === "REGISTRATION_METADATA_CHANGED"
        ? "REGISTRATION_METADATA_CHANGED" : "REGISTRATION_METADATA_UNAVAILABLE");
    }
    let committed: Data;
    try {
      committed = await config.rpc({...reference, action: "registration_commit", registration, lease_id: lease, observations: [first, second]});
    } catch {
      try { committed = await config.rpc({...reference, action: "registration_inspect", registration, lease_id: lease}); }
      catch { return await defer("REGISTRATION_COMMIT_UNKNOWN"); }
    }
    if (committed.contract === CONTRACT && committed.status === "retry_wait" && committed.execution_permitted === false)
      return failure(original, "REGISTRATION_COMMIT_NOT_APPLIED", "retry_wait");
    if (committed.contract === CONTRACT && committed.status === "failed" && committed.execution_permitted === false &&
        committed.connection_id === input.connection_id && committed.job_id === input.job_id && typeof committed.reason_code === "string")
      return failure(original, committed.reason_code, "failed");
    if (committed.contract === CONTRACT && committed.status === "already_current" && committed.connection_id === input.connection_id &&
        committed.job_id === input.job_id && committed.execution_permitted === false) return await config.rpc(input);
    if (committed.contract !== CONTRACT || committed.status !== "committed" || committed.connection_id !== input.connection_id ||
        committed.job_id !== input.job_id || committed.artifact_id !== registration.artifact_id ||
        committed.provider_file_version !== registration.expected_version || committed.execution_permitted !== false ||
        !uuid(committed.receipt_id) || !uuid(committed.registration_receipt_id)) return await defer("REGISTRATION_COMMIT_UNCONFIRMED");
    // This is a metadata recovery receipt, never a provider-effect permit.
    // The original job, expected version and immutable snapshot stay untouched.
    return await config.rpc(input);
  };
}
